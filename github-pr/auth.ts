import { z } from "npm:zod@4.4.3";

const API_ORIGIN = "https://api.github.com";

export const AuthModeSchema = z.enum(["token", "gh"]).default("token");
export const TokenSchema = z.string().min(1).optional().meta({
  sensitive: true,
});

export const GithubAuthConfigSchema = z.object({
  authMode: AuthModeSchema,
  token: TokenSchema,
}).superRefine((config, ctx) => {
  if (config.authMode === "token" && !config.token) {
    ctx.addIssue({
      code: "custom",
      path: ["token"],
      message: "token is required when authMode is token",
    });
  }
});

export type FetchLike = typeof fetch;

export type GhResult = {
  code: number;
  stdout: string;
  stderr: string;
};

/** Injectable runner for the authenticated GitHub CLI. */
export type GhRunner = (
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<GhResult>;

/** Run gh without a shell so endpoint and field values stay argument-bound. */
export const runGh: GhRunner = async (args, signal) => {
  // swamp-quality-ignore deno-command: gh is run with an argument array, never a shell
  const output = await new Deno.Command("gh", {
    args: [...args],
    stdout: "piped",
    stderr: "piped",
    signal,
  }).output();
  const decoder = new TextDecoder();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
};

export type GithubRequestOptions = {
  method?: "GET" | "POST";
  body?: Record<string, string | boolean | number>;
  signal?: AbortSignal;
};

/** Structured error that preserves HTTP status for the duplicate-PR race path. */
export class GithubApiError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number | null,
    detail: string,
  ) {
    const suffix = detail.trim().length > 0
      ? `: ${detail.trim().slice(0, 500)}`
      : "";
    super(
      `GitHub request ${path} failed${
        status === null ? "" : ` with HTTP ${status}`
      }${suffix}`,
    );
    this.name = "GithubApiError";
  }
}

function endpoint(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new GithubApiError(
      path,
      null,
      `GitHub returned non-JSON output: ${text.trim().slice(0, 500)}`,
    );
  }
}

function ghStatus(stderr: string): number | null {
  const match = stderr.match(/\bHTTP\s+(\d{3})\b/i);
  return match ? Number(match[1]) : null;
}

async function requestWithGh(
  path: string,
  options: GithubRequestOptions,
  ghRunner: GhRunner,
): Promise<unknown> {
  const method = options.method ?? "GET";
  const args: string[] = [
    "api",
    "--hostname",
    "github.com",
    "--method",
    method,
    endpoint(path),
  ];
  for (const [key, value] of Object.entries(options.body ?? {})) {
    if (typeof value === "string") {
      args.push("--raw-field", `${key}=${value}`);
    } else {
      args.push("--field", `${key}=${String(value)}`);
    }
  }

  const result = await ghRunner(args, options.signal);
  if (result.code !== 0) {
    throw new GithubApiError(path, ghStatus(result.stderr), result.stderr);
  }
  return parseJson(result.stdout, path);
}

async function requestWithToken(
  config: z.infer<typeof GithubAuthConfigSchema>,
  path: string,
  options: GithubRequestOptions,
  fetchImpl: FetchLike,
): Promise<unknown> {
  const response = await fetchImpl(`${API_ORIGIN}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jeremy-swamp-github-pr",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new GithubApiError(path, response.status, await response.text());
  }
  return await response.json();
}

/** Use either a vault-backed token or the active gh CLI login for GitHub API calls. */
export async function githubJson(
  rawConfig: unknown,
  path: string,
  options: GithubRequestOptions = {},
  fetchImpl: FetchLike = fetch,
  ghRunner: GhRunner = runGh,
): Promise<unknown> {
  const config = GithubAuthConfigSchema.parse(rawConfig);
  return config.authMode === "gh"
    ? await requestWithGh(path, options, ghRunner)
    : await requestWithToken(config, path, options, fetchImpl);
}
