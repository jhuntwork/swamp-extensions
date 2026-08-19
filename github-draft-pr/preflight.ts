import { z } from "npm:zod@4.4.3";

const API_ORIGIN = "https://api.github.com";

export const PreflightConfigSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  baseBranch: z.string().min(1).max(255).refine((value) => !/\s/.test(value)),
  expectedActor: z.string().min(1).max(255),
  token: z.string().min(1).meta({ sensitive: true }),
});

export const PreflightResultSchema = z.object({
  actor: z.string(),
  repository: z.string(),
  repositoryId: z.number().int().positive(),
  defaultBranch: z.string(),
  baseBranch: z.string(),
  baseSha: z.string().regex(/^[0-9a-f]{40,64}$/),
});

type PreflightConfig = z.infer<typeof PreflightConfigSchema>;
type FetchLike = typeof fetch;

function endpoint(path: string): string {
  return `${API_ORIGIN}${path}`;
}

async function getJson(
  fetchImpl: FetchLike,
  config: PreflightConfig,
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchImpl(endpoint(path), {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jeremy-swamp-github-draft-pr",
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `GitHub preflight ${path} failed with HTTP ${response.status}`,
    );
  }
  return await response.json();
}

/** Verify the actor, bound repository, and configured base branch without mutation. */
export async function preflight(
  rawConfig: unknown,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<z.infer<typeof PreflightResultSchema>> {
  const config = PreflightConfigSchema.parse(rawConfig);
  const actor = await getJson(fetchImpl, config, "/user", signal) as {
    login?: unknown;
  };
  if (actor.login !== config.expectedActor) {
    throw new Error("GitHub authenticated actor does not match expectedActor");
  }

  const repository = await getJson(
    fetchImpl,
    config,
    `/repos/${config.repository}`,
    signal,
  ) as {
    id?: unknown;
    full_name?: unknown;
    default_branch?: unknown;
  };
  if (repository.full_name !== config.repository) {
    throw new Error(
      "GitHub repository identity does not match the bound repository",
    );
  }

  const ref = await getJson(
    fetchImpl,
    config,
    `/repos/${config.repository}/git/ref/heads/${
      encodeURIComponent(config.baseBranch)
    }`,
    signal,
  ) as { object?: { sha?: unknown } };

  return PreflightResultSchema.parse({
    actor: actor.login,
    repository: repository.full_name,
    repositoryId: repository.id,
    defaultBranch: repository.default_branch,
    baseBranch: config.baseBranch,
    baseSha: typeof ref.object?.sha === "string"
      ? ref.object.sha.toLowerCase()
      : ref.object?.sha,
  });
}
