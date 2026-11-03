import { z } from "npm:zod@4.4.3";
import {
  AuthModeSchema,
  FetchLike,
  GhRunner,
  githubJson,
  TokenSchema,
} from "./auth.ts";

export const PreflightConfigSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  baseBranch: z.string().min(1).max(255).refine((value) => !/\s/.test(value)),
  expectedActor: z.string().min(1).max(255),
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

export const PreflightResultSchema = z.object({
  actor: z.string(),
  repository: z.string(),
  repositoryId: z.number().int().positive(),
  defaultBranch: z.string(),
  baseBranch: z.string(),
  baseSha: z.string().regex(/^[0-9a-f]{40,64}$/),
});

/** Verify the actor, bound repository, and configured base branch without mutation. */
export async function preflight(
  rawConfig: unknown,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
  ghRunner?: GhRunner,
): Promise<z.infer<typeof PreflightResultSchema>> {
  const config = PreflightConfigSchema.parse(rawConfig);
  const actor = await githubJson(
    config,
    "/user",
    { signal },
    fetchImpl,
    ghRunner,
  ) as {
    login?: unknown;
  };
  if (actor.login !== config.expectedActor) {
    throw new Error("GitHub authenticated actor does not match expectedActor");
  }

  const repository = await githubJson(
    config,
    `/repos/${config.repository}`,
    { signal },
    fetchImpl,
    ghRunner,
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

  const ref = await githubJson(
    config,
    `/repos/${config.repository}/git/ref/heads/${
      encodeURIComponent(config.baseBranch)
    }`,
    { signal },
    fetchImpl,
    ghRunner,
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
