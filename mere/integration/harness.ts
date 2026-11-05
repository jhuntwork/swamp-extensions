import { join } from "node:path";

/** A throwaway swamp repo with this extension source-added. */
export interface Repo {
  dir: string;
  swamp(args: string[], env?: Record<string, string>): Promise<SwampResult>;
  json(args: string[]): Promise<Record<string, unknown>>;
  cleanup(): Promise<void>;
}

export interface SwampResult {
  code: number;
  stdout: string;
  stderr: string;
}

const KEEP = new Set(["SWAMP_HOME"]);

/** Strip every inherited SWAMP_* variable except SWAMP_HOME. */
export function swampEnv(
  inherited: Record<string, string>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (key.startsWith("SWAMP_") && !KEEP.has(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    SWAMP_NO_TELEMETRY: "1",
    SWAMP_NO_UPDATE_CHECK: "1",
    ...extra,
  };
}

export const EXTENSION_DIR = new URL("../", import.meta.url).pathname;

export async function createRepo(): Promise<Repo> {
  const dir = await Deno.makeTempDir({ prefix: "mere-it-" });
  const run = async (args: string[], extra: Record<string, string> = {}) => {
    const output = await new Deno.Command("swamp", {
      args,
      cwd: dir,
      env: swampEnv(Deno.env.toObject(), extra),
      clearEnv: true,
      stdin: "null",
    }).output();
    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  };
  const init = await run(["init", "--tool", "none"]);
  if (init.code !== 0) throw new Error(`swamp init failed: ${init.stderr}`);
  const add = await run([
    "extension",
    "source",
    "add",
    EXTENSION_DIR.replace(/\/$/, ""),
  ]);
  if (add.code !== 0) throw new Error(`source add failed: ${add.stderr}`);
  return {
    dir,
    swamp: run,
    async json(args) {
      const result = await run([...args, "--json"]);
      const clean = (text: string) =>
        text.split("\n").filter((l) => !l.startsWith('{"event"')).join("\n")
          .trim();
      for (const text of [clean(result.stdout), clean(result.stderr)]) {
        if (!text) continue;
        try {
          return JSON.parse(text);
        } catch { /* try the next stream */ }
      }
      throw new Error(
        `not JSON (exit ${result.code}): ${result.stdout}${result.stderr}`,
      );
    },
    cleanup: async () => {
      // mere's store entries are read-only by design; unlock before removing.
      await new Deno.Command("chmod", { args: ["-R", "u+rwX", dir] }).output();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

export function repoPath(repo: Repo, ...parts: string[]) {
  return join(repo.dir, ...parts);
}

export const NETWORK = Deno.env.get("MERE_INTEGRATION_NET") === "1";
