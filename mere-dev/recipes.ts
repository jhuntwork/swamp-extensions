import { z } from "npm:zod@4.1.12";
import { join } from "node:path";
import { parseRecipe, parseUpstreamOverride } from "./lib/kdl.ts";
import { bumpRelease as editBumpRelease, setVersion } from "./lib/edit.ts";
import { findDependents, renderSummary } from "./lib/bump.ts";
import { runChecked, runCommand } from "./lib/runner.ts";

const GlobalArgs = z.object({
  repoUrl: z.string().min(1).default(
    "https://github.com/jhuntwork/merelinux.git",
  ).describe(
    "Git URL of the recipe repository: https, ssh:// or scp-style (git@host:path).",
  ),
  ref: z.string().default("main"),
  checkoutPath: z.string().default("").describe(
    "Empty derives .swamp/mere/checkouts/merelinux under the repo.",
  ),
  ensureCheckout: z.boolean().default(true).describe(
    "Clone or update the checkout through @swamp/git before reading. Set " +
      "false where runModel is unavailable (remote workers) and run an " +
      "ensure_checkout step first.",
  ),
});

const SourceSchema = z.object({
  url: z.string(),
  resolvedUrl: z.string(),
  isLocal: z.boolean(),
  interpolatesVersion: z.boolean(),
  blake3: z.string().optional(),
  saveAs: z.string().optional(),
});

const RecipeSchema = z.object({
  path: z.string(),
  category: z.string(),
  name: z.string(),
  version: z.string(),
  release: z.number().int().nonnegative(),
  description: z.string(),
  url: z.string(),
  licenses: z.array(z.string()),
  archs: z.array(z.string()),
  depends: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  needsRoot: z.boolean(),
  sources: z.array(SourceSchema),
  packages: z.array(z.object({
    name: z.string(),
    hasService: z.boolean(),
    hasRealizer: z.boolean(),
  })),
  phases: z.array(z.string()),
  sha256OfFile: z.string(),
  normalized: z.boolean(),
  hardcodedVersion: z.object({ exact: z.boolean(), series: z.boolean() }),
  upstreamOverride: z.object({
    anityaProjectId: z.number().int().optional(),
    github: z.string().optional(),
    tagPrefix: z.string().optional(),
    exclude: z.array(z.string()).optional(),
    patchSuffix: z.string().optional(),
  }).optional(),
  commit: z.string(),
  schemaVersion: z.literal(1),
});

const ChangeSchema = z.object({
  recipe: z.string(),
  path: z.string(),
  checkoutPath: z.string(),
  baseCommit: z.string(),
  version: z.object({ before: z.string(), after: z.string() }),
  release: z.object({ before: z.number().int(), after: z.number().int() }),
  sources: z.array(z.object({
    url: z.string(),
    blake3Before: z.string(),
    blake3After: z.string(),
  })),
  fileSha256Before: z.string(),
  fileSha256After: z.string(),
  hardcodedVersion: z.object({ exact: z.boolean(), series: z.boolean() }),
  schemaVersion: z.literal(1),
});

const SetVersionArgs = z.object({
  recipe: z.string().regex(/^[a-z0-9][a-z0-9._+-]*\/[a-z0-9][a-z0-9._+-]*$/i),
  version: z.string().min(1),
  release: z.number().int().nonnegative().default(1),
  sources: z.array(z.object({
    url: z.string().min(1).describe("The source URL as written in the recipe"),
    blake3: z.string().regex(/^[a-f0-9]{64}$/),
  })).default([]),
  checkoutPath: z.string().min(1).describe(
    "The per-run worktree to edit. Never the shared checkout; required.",
  ),
  allowHardcodedVersion: z.boolean().default(false),
});

const RecipeCheckoutArgs = z.object({
  recipe: z.string().regex(/^[a-z0-9][a-z0-9._+-]*\/[a-z0-9][a-z0-9._+-]*$/i),
  checkoutPath: z.string().min(1).describe(
    "The per-run worktree holding the recipe to check; absolute.",
  ),
});

const ReleaseBumpArgs = RecipeCheckoutArgs;

const CleanupSchema = z.object({
  path: z.string(),
  branch: z.string(),
  existed: z.boolean(),
  removed: z.boolean(),
  branchDeleted: z.boolean(),
  schemaVersion: z.literal(1),
});

const WorkspaceSchema = z.object({
  key: z.string(),
  checkoutPath: z.string(),
  worktreeRoot: z.string(),
  worktreePath: z.string(),
  repoUrl: z.string(),
  ref: z.string(),
  schemaVersion: z.literal(1),
});

const SummarySchema = z.object({
  recipe: z.string(),
  name: z.string(),
  title: z.string(),
  commitMessage: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
  dependents: z.array(z.string()),
  schemaVersion: z.literal(1),
});

const DependentsSchema = z.object({
  name: z.string(),
  dependents: z.array(z.string()),
  commit: z.string(),
  schemaVersion: z.literal(1),
});

const ScanSchema = z.object({
  commit: z.string(),
  ref: z.string(),
  total: z.number().int().nonnegative(),
  parsed: z.number().int().nonnegative(),
  normalized: z.array(z.string()),
  hardcodedVersion: z.array(z.string()),
  upstreamOverrides: z.array(z.string()),
  failures: z.array(z.object({ path: z.string(), error: z.string() })),
  durationMs: z.number().nonnegative(),
  schemaVersion: z.literal(1),
});

type Context = {
  repoDir: string;
  signal: AbortSignal;
  globalArgs: z.infer<typeof GlobalArgs>;
  definition: { name: string };
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readModelData: (
    name: string,
    spec?: string,
  ) => Promise<{ attributes: Record<string, unknown> }[]>;
  runModel?: (options: Record<string, unknown>) => Promise<
    { ok: true } | { ok: false; error: { message: string } }
  >;
};

/** Resolve a recipe checkout path from the repo directory and optional override. */
export function checkoutDir(repoDir: string, configured: string): string {
  return configured ||
    join(repoDir, ".swamp", "mere", "checkouts", "merelinux");
}

async function prepareCheckout(context: Context): Promise<string> {
  const globals = GlobalArgs.parse(context.globalArgs);
  const path = checkoutDir(context.repoDir, globals.checkoutPath);
  if (globals.ensureCheckout) {
    if (!context.runModel) {
      throw new Error(
        "runModel is unavailable here; set ensureCheckout=false and run an " +
          "@swamp/git ensure_checkout step first",
      );
    }
    const result = await context.runModel({
      modelType: "@swamp/git",
      name: `${context.definition.name}-git`,
      method: "ensure_checkout",
      arguments: {
        repoPath: path,
        url: globals.repoUrl,
        path,
        ref: globals.ref,
        reset: true,
      },
    });
    if (!result.ok) throw new Error(`ensure_checkout: ${result.error.message}`);
  }
  return path;
}

async function headCommit(path: string, signal: AbortSignal): Promise<string> {
  const result = await runChecked("git", ["-C", path, "rev-parse", "HEAD"], {
    signal,
    timeoutMs: 30_000,
  });
  return result.stdout.trim();
}

/** upstream.kdl beside a recipe, if any. An unreadable one throws. */
async function readOverride(root: string, rel: string) {
  const overridePath = rel.replace(/recipe\.kdl$/, "upstream.kdl");
  let text: string;
  try {
    text = await Deno.readTextFile(join(root, overridePath));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  return parseUpstreamOverride(text, overridePath);
}

const RECIPE_PATH = /^[a-z0-9][a-z0-9._+-]*\/[a-z0-9][a-z0-9._+-]*$/i;

/** Build the stable data instance name for a parsed recipe. */
export function recipeInstanceName(category: string, name: string): string {
  return `recipe-${category}-${name}`;
}

async function listRecipes(root: string): Promise<string[]> {
  const found: string[] = [];
  for await (const category of Deno.readDir(join(root, "recipes"))) {
    if (!category.isDirectory) continue;
    for await (
      const entry of Deno.readDir(join(root, "recipes", category.name))
    ) {
      if (!entry.isDirectory) continue;
      const file = join(
        root,
        "recipes",
        category.name,
        entry.name,
        "recipe.kdl",
      );
      try {
        await Deno.stat(file);
        found.push(`recipes/${category.name}/${entry.name}/recipe.kdl`);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  }
  return found.sort();
}

/** Behavior that reads, validates, builds, and edits Merelinux recipes. */
export const model = {
  type: "@jeremy/mere-dev/recipes",
  version: "2026.11.13.5",
  description:
    "Read, scan, edit, and summarize merelinux recipes. Running mere on them belongs to @jeremy/mere-dev.",
  upgrades: [{
    toVersion: "2026.11.08.11",
    description:
      "Generate one maintainer-facing upstream paragraph for every recipe bump PR.",
    upgradeAttributes: (
      old: Record<string, unknown>,
    ): Record<string, unknown> => old,
  }, {
    toVersion: "2026.11.13.5",
    description:
      "Moved from @jeremy/mere/recipe to @jeremy/mere-dev/recipes. The toolchain and signingKey global arguments, the validate, build and importOutputs methods, and their resources moved to the mere-dev behavior.",
    upgradeAttributes: (
      old: Record<string, unknown>,
    ): Record<string, unknown> => {
      const { toolchain: _toolchain, signingKey: _signingKey, ...rest } = old;
      return rest;
    },
  }],
  globalArguments: GlobalArgs,
  resources: {
    recipe: {
      description: "One parsed recipe",
      schema: RecipeSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    change: {
      description: "A recorded edit of one recipe: before and after",
      schema: ChangeSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    workspace: {
      description:
        "Standard paths for one bump run: shared checkout and worktree",
      schema: WorkspaceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    cleanup: {
      description: "Result of removing a stale bump worktree",
      schema: CleanupSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    summary: {
      description: "Title, commit message, PR body and labels for a change",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    dependents: {
      description: "Recipes that depend on one recipe",
      schema: DependentsSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    scan: {
      description:
        "Outcome of a tree scan, including recipes that failed to parse",
      schema: ScanSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    workspace: {
      description:
        "Compute the standard paths for one piece of work: the shared " +
        "checkout and a worktree named by `key` (the branch) under the " +
        "repo's .swamp/mere/worktrees. Touches nothing.",
      kind: "read",
      arguments: z.object({
        key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/),
      }),
      execute: async (args: { key: string }, context: Context) => {
        const globals = GlobalArgs.parse(context.globalArgs);
        const worktreeRoot = join(
          context.repoDir,
          ".swamp",
          "mere",
          "worktrees",
        );
        const handle = await context.writeResource("workspace", "workspace", {
          key: args.key,
          checkoutPath: checkoutDir(context.repoDir, globals.checkoutPath),
          worktreeRoot,
          worktreePath: join(worktreeRoot, args.key),
          repoUrl: globals.repoUrl,
          ref: globals.ref,
          schemaVersion: 1,
        });
        return { dataHandles: [handle] };
      },
    },
    cleanWorktree: {
      description:
        "Remove a stale bump worktree and its local branch so a retry starts " +
        "clean. Only touches a registered worktree of the shared checkout, " +
        "inside the worktree root, on a branch named bump-*. Nothing already " +
        "pushed is affected.",
      kind: "action",
      arguments: z.object({
        key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/),
        branch: z.string().regex(/^bump-[A-Za-z0-9._-]+$/),
      }),
      execute: async (
        args: { key: string; branch: string },
        context: Context,
      ) => {
        const globals = GlobalArgs.parse(context.globalArgs);
        const checkout = checkoutDir(context.repoDir, globals.checkoutPath);
        const path = join(
          context.repoDir,
          ".swamp",
          "mere",
          "worktrees",
          args.key,
        );
        const registered = (await runChecked(
          "git",
          ["-C", checkout, "worktree", "list", "--porcelain"],
          { signal: context.signal, timeoutMs: 30_000 },
        )).stdout.split("\n").some((l) => l === `worktree ${path}`);
        let removed = false;
        if (registered) {
          await runChecked(
            "git",
            ["-C", checkout, "worktree", "remove", "--force", path],
            { signal: context.signal, timeoutMs: 60_000 },
          );
          removed = true;
        }
        await runChecked("git", ["-C", checkout, "worktree", "prune"], {
          signal: context.signal,
          timeoutMs: 30_000,
        });
        const branchExists = (await runCommand(
          "git",
          [
            "-C",
            checkout,
            "rev-parse",
            "--verify",
            "--quiet",
            `refs/heads/${args.branch}`,
          ],
          { signal: context.signal, timeoutMs: 30_000 },
        )).exitCode === 0;
        if (branchExists) {
          await runChecked(
            "git",
            ["-C", checkout, "branch", "-D", args.branch],
            {
              signal: context.signal,
              timeoutMs: 30_000,
            },
          );
        }
        const handle = await context.writeResource("cleanup", "cleanup", {
          path,
          branch: args.branch,
          existed: registered,
          removed,
          branchDeleted: branchExists,
          schemaVersion: 1,
        });
        return { dataHandles: [handle] };
      },
    },
    dependents: {
      description:
        "List the recipes whose `depends` name this recipe or its -dev " +
        "package, from the latest scan data.",
      kind: "read",
      arguments: z.object({ name: z.string().min(1) }),
      execute: async (args: { name: string }, context: Context) => {
        const records = await context.readModelData(
          context.definition.name,
          "recipe",
        );
        if (records.length === 0) {
          throw new Error("no recipe data; run scan first");
        }
        const recipes = records.map((r) =>
          r.attributes as {
            name: string;
            depends: string[];
            commit: string;
          }
        );
        const handle = await context.writeResource(
          "dependents",
          `dependents-${args.name}`,
          {
            name: args.name,
            dependents: findDependents(recipes, args.name),
            commit: recipes[0].commit,
            schemaVersion: 1,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    summarize: {
      description:
        "Write the title, commit message, PR body and labels for a bump from " +
        "recorded data only (the change, the build, the bump plan and the " +
        "dependents); no model call.",
      kind: "read",
      arguments: z.object({
        recipe: z.string().regex(
          /^[a-z0-9][a-z0-9._+-]*\/[a-z0-9][a-z0-9._+-]*$/i,
        ),
        sourceBinding: z.string().min(1).default("merelinux-upstream"),
        devBinding: z.string().min(1).default("merelinux-recipe-validation")
          .describe("The @jeremy/mere-dev behavior that built the recipe"),
        runId: z.string().min(1),
      }),
      execute: async (
        args: {
          recipe: string;
          sourceBinding: string;
          devBinding: string;
          runId: string;
        },
        context: Context,
      ) => {
        const name = args.recipe.split("/")[1];
        const own = context.definition.name;
        const one = async (binding: string, spec: string, instance: string) => {
          const found = (await context.readModelData(binding, spec))
            .find((r) => (r as unknown as { name?: string }).name === instance);
          if (!found) {
            throw new Error(
              `no ${spec} "${instance}" in ${binding}; run its step first`,
            );
          }
          return found.attributes as Record<string, unknown>;
        };
        const change = await one(own, "change", `change-${name}`);
        const build = await one(
          args.devBinding,
          "build-result",
          "build-result",
        );
        if (build.recipe !== args.recipe) {
          throw new Error(
            `the latest build in ${args.devBinding} is for ${build.recipe}, not ${args.recipe}`,
          );
        }
        const bump = await one(args.sourceBinding, "bump", `bump-${name}`);
        if (!build.ok) throw new Error(`the build of ${name} did not succeed`);
        const recipes = (await context.readModelData(own, "recipe")).map((r) =>
          r.attributes as { name: string; depends: string[] }
        );
        const dependents = findDependents(recipes, name);
        const summary = renderSummary({
          name,
          recipe: args.recipe,
          runId: args.runId,
          change: change as never,
          bump: bump as never,
          build: build as never,
          dependents,
        });
        const handle = await context.writeResource(
          "summary",
          `summary-${name}`,
          {
            recipe: args.recipe,
            name,
            ...summary,
            dependents,
            schemaVersion: 1,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    setVersion: {
      description:
        "Move a recipe to a new version in a worktree: edits only the version " +
        "line, the release line and the blake3 of each source whose URL " +
        "carries ${recipe.version}; every other byte is preserved. The result " +
        "is re-parsed and compared with the original before it is written. " +
        "Refuses recipes that spell out their version in scripts unless told to.",
      kind: "action",
      arguments: SetVersionArgs,
      execute: async (
        args: z.infer<typeof SetVersionArgs>,
        context: Context,
      ) => {
        if (!args.checkoutPath.startsWith("/")) {
          throw new Error("checkoutPath must be an absolute path");
        }
        const rel = `recipes/${args.recipe}/recipe.kdl`;
        const file = join(args.checkoutPath, rel);
        const text = await Deno.readTextFile(file);
        const hashes: Record<string, string> = {};
        for (const source of args.sources) {
          if (source.url in hashes) {
            throw new Error(`source "${source.url}" given twice`);
          }
          hashes[source.url] = source.blake3;
        }
        const baseCommit = await headCommit(args.checkoutPath, context.signal);
        const edited = setVersion(text, rel, {
          version: args.version,
          release: args.release,
          hashes,
          allowHardcodedVersion: args.allowHardcodedVersion,
        });
        const temporary = `${file}.${crypto.randomUUID()}.tmp`;
        await Deno.writeTextFile(temporary, edited.text);
        await Deno.rename(temporary, file);
        const name = args.recipe.split("/")[1];
        const handle = await context.writeResource("change", `change-${name}`, {
          recipe: args.recipe,
          path: rel,
          checkoutPath: args.checkoutPath,
          baseCommit,
          ...edited.change,
          schemaVersion: 1,
        });
        return { dataHandles: [handle] };
      },
    },
    bumpRelease: {
      description:
        "Increment a recipe's release number in a worktree without changing " +
        "its version, sources or any other file content.",
      kind: "action",
      arguments: ReleaseBumpArgs,
      execute: async (
        args: z.infer<typeof ReleaseBumpArgs>,
        context: Context,
      ) => {
        if (!args.checkoutPath.startsWith("/")) {
          throw new Error("checkoutPath must be an absolute path");
        }
        const rel = `recipes/${args.recipe}/recipe.kdl`;
        const file = join(args.checkoutPath, rel);
        const text = await Deno.readTextFile(file);
        const baseCommit = await headCommit(args.checkoutPath, context.signal);
        const edited = editBumpRelease(text, rel);
        const temporary = `${file}.${crypto.randomUUID()}.tmp`;
        await Deno.writeTextFile(temporary, edited.text);
        await Deno.rename(temporary, file);
        const name = args.recipe.split("/")[1];
        const handle = await context.writeResource("change", `change-${name}`, {
          recipe: args.recipe,
          path: rel,
          checkoutPath: args.checkoutPath,
          baseCommit,
          ...edited.change,
          schemaVersion: 1,
        });
        return { dataHandles: [handle] };
      },
    },
    read: {
      description: "Parse one recipe (<category>/<name>) from the checkout.",
      kind: "read",
      arguments: z.object({
        recipe: z.string().regex(RECIPE_PATH, "expected <category>/<name>"),
      }),
      execute: async (args: { recipe: string }, context: Context) => {
        const root = await prepareCheckout(context);
        const rel = `recipes/${args.recipe}/recipe.kdl`;
        const text = await Deno.readTextFile(join(root, rel));
        const parsed = parseRecipe(text, rel);
        const commit = await headCommit(root, context.signal);
        const upstreamOverride = await readOverride(root, rel);
        const handle = await context.writeResource(
          "recipe",
          recipeInstanceName(parsed.category, parsed.name),
          {
            ...parsed,
            ...(upstreamOverride ? { upstreamOverride } : {}),
            commit,
            schemaVersion: 1,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    scan: {
      description:
        "Parse every recipe in the tree in one pass (one resource per recipe). " +
        "A recipe that fails to parse is listed in the scan summary rather " +
        "than hiding the rest; callers decide whether that is fatal.",
      kind: "read",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Context) => {
        const started = performance.now();
        const root = await prepareCheckout(context);
        const commit = await headCommit(root, context.signal);
        const handles: { name: string }[] = [];
        const failures: { path: string; error: string }[] = [];
        const normalized: string[] = [];
        const hardcoded: string[] = [];
        const overrides: string[] = [];
        let total = 0;
        for (const rel of await listRecipes(root)) {
          context.signal.throwIfAborted();
          total++;
          try {
            const parsed = parseRecipe(
              await Deno.readTextFile(join(root, rel)),
              rel,
            );
            if (parsed.normalized) normalized.push(rel);
            if (
              parsed.hardcodedVersion.exact || parsed.hardcodedVersion.series
            ) {
              hardcoded.push(parsed.name);
            }
            let upstreamOverride;
            try {
              upstreamOverride = await readOverride(root, rel);
            } catch (error) {
              // A bad override must not hide the recipe; report it.
              failures.push({
                path: rel.replace(/recipe\.kdl$/, "upstream.kdl"),
                error: (error instanceof Error ? error.message : String(error))
                  .slice(0, 300),
              });
            }
            if (upstreamOverride) overrides.push(parsed.name);
            handles.push(
              await context.writeResource(
                "recipe",
                recipeInstanceName(parsed.category, parsed.name),
                {
                  ...parsed,
                  ...(upstreamOverride ? { upstreamOverride } : {}),
                  commit,
                  schemaVersion: 1,
                },
              ),
            );
          } catch (error) {
            failures.push({
              path: rel,
              error: (error instanceof Error ? error.message : String(error))
                .slice(0, 300),
            });
          }
        }
        handles.push(
          await context.writeResource("scan", "scan", {
            commit,
            ref: GlobalArgs.parse(context.globalArgs).ref,
            total,
            parsed: handles.length,
            normalized,
            hardcodedVersion: hardcoded,
            upstreamOverrides: overrides,
            failures,
            durationMs: performance.now() - started,
            schemaVersion: 1,
          }),
        );
        return { dataHandles: handles };
      },
    },
  },
};
