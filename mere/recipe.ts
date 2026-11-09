import { z } from "npm:zod@4.1.12";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseRecipe, parseUpstreamOverride } from "./models/_lib/kdl.ts";
import {
  bumpRelease as editBumpRelease,
  setVersion,
} from "./models/_lib/edit.ts";
import { findDependents, renderSummary } from "./models/_lib/bump.ts";
import { runChecked, runCommand } from "./models/_lib/runner.ts";

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
  toolchain: z.string().default("mere").describe(
    "Name of the @jeremy/mere/toolchain behavior whose provisioned mere " +
      "binary and isolated root validate and build use.",
  ),
  ensureCheckout: z.boolean().default(true).describe(
    "Clone or update the checkout through @swamp/git before reading. Set " +
      "false where runModel is unavailable (remote workers) and run an " +
      "ensure_checkout step first.",
  ),
  signingKey: z.string().default("").meta({ sensitive: true }).describe(
    "Optional base64 Mere .key signing key. The key is written only to " +
      "the isolated Mere root for build/import and is removed afterward.",
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

const ValidationSchema = z.object({
  recipe: z.string(),
  path: z.string(),
  ok: z.boolean(),
  exitCode: z.number().int(),
  output: z.string(),
  mereVersion: z.string(),
  durationMs: z.number().nonnegative(),
  schemaVersion: z.literal(1),
});

const BuildSchema = z.object({
  recipe: z.string(),
  name: z.string(),
  version: z.string(),
  release: z.number().int(),
  arch: z.string(),
  ok: z.boolean(),
  exitCode: z.number().int(),
  noCache: z.boolean(),
  durationMs: z.number().nonnegative(),
  failingPhase: z.string().describe("Empty on success"),
  errorLine: z.string().describe(
    "mere's first error message, empty on success",
  ),
  outputs: z.array(z.object({
    fileName: z.string(),
    path: z.string(),
    package: z.string(),
    contentId: z.string().describe("The hash in mere's archive file name"),
    sha256: z.string(),
    bytes: z.number().int().nonnegative(),
  })),
  logTail: z.string(),
  schemaVersion: z.literal(1),
});

const ImportArgs = z.object({
  repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).default(
    "local",
  ).describe("Local development repository name under the isolated Mere root."),
});

const ImportResultSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().nonnegative(),
  mereVersion: z.string(),
  mereRoot: z.string(),
  repository: z.string(),
  keyFingerprint: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});

const RecipeCheckoutArgs = z.object({
  recipe: z.string().regex(/^[a-z0-9][a-z0-9._+-]*\/[a-z0-9][a-z0-9._+-]*$/i),
  checkoutPath: z.string().min(1).describe(
    "The per-run worktree holding the recipe to check; absolute.",
  ),
});

const BuildArgs = RecipeCheckoutArgs.extend({
  noCache: z.boolean().default(true).describe("As CI does."),
  timeoutMinutes: z.number().int().min(1).max(240).default(60),
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
  createFileWriter: (
    spec: string,
    name: string,
  ) => { writeText(text: string): Promise<{ name: string }> };
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

/** Pull the failing phase and mere's first error out of a build's output tail. */
export function diagnose(
  tail: string,
): { failingPhase: string; errorLine: string } {
  const lines = tail.split("\n");
  let failingPhase = "";
  for (const line of lines) {
    const m = /^error (\S+) failed/.exec(line);
    if (m) failingPhase = m[1];
  }
  const errorLine =
    lines.map((l) => l.trim()).find((l) => l.startsWith("error:")) ??
      lines.map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  return { failingPhase, errorLine: errorLine.slice(0, 400) };
}

function recipeFile(
  args: { recipe: string; checkoutPath: string },
): string {
  if (!args.checkoutPath.startsWith("/")) {
    throw new Error("checkoutPath must be an absolute path");
  }
  return join(args.checkoutPath, "recipes", args.recipe, "recipe.kdl");
}

/** The provisioned mere binary and root, from the toolchain behavior's data. */
async function toolchainOf(
  context: Context,
): Promise<{ binary: string; root: string; version: string }> {
  const name = GlobalArgs.parse(context.globalArgs).toolchain;
  const records = await context.readModelData(name, "toolchain");
  const data = records[0]?.attributes as
    | { binaryPath?: string; root?: string; version?: string }
    | undefined;
  if (!data?.binaryPath || !data.root) {
    throw new Error(
      `toolchain "${name}" has no data; run its provision method first ` +
        `(download mere with @svendowideit/github-release-install, then ` +
        `provision with the archive path and sha256)`,
    );
  }
  await Deno.stat(data.binaryPath);
  return {
    binary: data.binaryPath,
    root: data.root,
    version: data.version ?? "",
  };
}

async function listOutputs(
  dir: string,
  version: string,
  release: number,
  arch: string,
) {
  const out = [];
  const suffix = new RegExp(
    `-${
      version.replace(/[.+*?^$()|[\]\\]/g, "\\$&")
    }-${release}-${arch}-([0-9a-f]{64})\\.pkg\\.tar\\.zst$`,
  );
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".pkg.tar.zst")) continue;
    const match = suffix.exec(entry.name);
    const path = join(dir, entry.name);
    out.push({
      fileName: entry.name,
      path,
      package: match ? entry.name.slice(0, match.index) : entry.name,
      contentId: match?.[1] ?? "",
      sha256: await sha256OfFile(path),
      bytes: (await Deno.stat(path)).size,
    });
  }
  return out.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await Deno.open(path, { read: true });
  for await (const chunk of file.readable) hash.update(chunk);
  return hash.digest("hex");
}

export function decodeSigningKey(value: string): Uint8Array {
  const compact = value.replace(/\s+/g, "");
  let decoded: string;
  try {
    decoded = atob(compact);
  } catch {
    throw new Error("signingKey must be base64-encoded Mere .key material");
  }
  const bytes = Uint8Array.from(
    decoded,
    (character) => character.charCodeAt(0),
  );
  if (
    bytes.length !== 80 ||
    new TextDecoder().decode(bytes.slice(0, 8)) !== "MEREKEY\0" ||
    bytes[8] !== 1 || bytes[9] !== 2 || bytes[10] !== 1 || bytes[11] !== 0 ||
    new DataView(bytes.buffer, bytes.byteOffset + 12, 4).getUint32(0, true) !==
      64
  ) {
    throw new Error(
      `signingKey must decode to an 80-byte Mere secret key, got ${bytes.length} bytes`,
    );
  }
  return bytes;
}

function publicKeyFromSigningKey(secret: Uint8Array): Uint8Array {
  const header = new Uint8Array([
    0x4d,
    0x45,
    0x52,
    0x45,
    0x4b,
    0x45,
    0x59,
    0x00,
    0x01,
    0x01,
    0x01,
    0x00,
    0x20,
    0x00,
    0x00,
    0x00,
  ]);
  return Uint8Array.from([...header, ...secret.slice(48)]);
}

async function removeLegacyRepositoryConfig(
  root: string,
  repository: string,
): Promise<void> {
  const configPath = join(root, "mere", "config.kdl");
  let existing: string;
  try {
    existing = await Deno.readTextFile(configPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  const marker = `repo "${repository}" {`;
  const start = existing.indexOf(marker);
  if (start < 0) return;
  const close = existing.indexOf("}", start);
  if (close < 0) throw new Error(`invalid Mere config: unterminated ${marker}`);
  let begin = start;
  if (begin > 0 && existing[begin - 1] === "\n") begin--;
  let end = close + 1;
  if (existing[end] === "\n") end++;
  await Deno.writeTextFile(
    configPath,
    existing.slice(0, begin) + existing.slice(end),
  );
}

async function removeUninitializedRepository(
  root: string,
  repository: string,
): Promise<void> {
  const repositoryDir = join(root, "mere", "dev", "repo", repository);
  try {
    const database = await Deno.stat(join(repositoryDir, "repo.db"));
    if (database.isFile) return;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await Deno.remove(repositoryDir, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
}

/** Materialize the development key and isolated trust files for build/import. */
async function prepareSigningKey(
  binary: string,
  root: string,
  encoded: string,
  signal: AbortSignal,
): Promise<{ keyPath: string; home: string; fingerprint: string }> {
  if (!encoded) {
    throw new Error(
      "recipe signingKey is empty; configure the vault-backed development key " +
        "or run the explicit toolchain.generateDevKey procedure first",
    );
  }
  const key = decodeSigningKey(encoded);
  const home = join(root, "home");
  const keyDir = join(home, ".mere", "keys");
  const keyPath = join(keyDir, "mere.key");
  const publicPath = join(keyDir, "mere.pub");
  let wroteKey = false;
  let complete = false;
  try {
    await Deno.mkdir(keyDir, { recursive: true, mode: 0o700 });
    await Deno.writeFile(keyPath, key, { create: true, mode: 0o600 });
    wroteKey = true;
    await Deno.chmod(keyPath, 0o600);
    await Deno.writeFile(publicPath, publicKeyFromSigningKey(key), {
      create: true,
    });
    await Deno.chmod(publicPath, 0o644);
    const fingerprintResult = await runCommand(
      binary,
      ["dev", "key", "fingerprint", publicPath],
      { signal, timeoutMs: 30_000, maxOutputBytes: 4_096 },
    );
    if (fingerprintResult.exitCode !== 0) {
      throw new Error(
        `mere dev key fingerprint failed: ${
          (fingerprintResult.stderr || fingerprintResult.stdout).trim()
        }`,
      );
    }
    const fingerprint = fingerprintResult.stdout.match(/[0-9a-f]{64}/i)?.[0]
      ?.toLowerCase();
    if (!fingerprint) {
      throw new Error("mere returned no development key fingerprint");
    }
    complete = true;
    return { keyPath, home, fingerprint };
  } finally {
    if (wroteKey && !complete) {
      await Deno.remove(keyPath).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
  }
}

/** mere's workspace for the most recent build of this recipe tuple. */
async function latestBuildLog(root: string, tuple: string, since: number) {
  const base = join(root, "mere", "dev", "build");
  let best: { path: string; mtime: number } | undefined;
  try {
    for await (const entry of Deno.readDir(base)) {
      if (!entry.isDirectory || !entry.name.startsWith(`${tuple}-`)) continue;
      const path = join(base, entry.name, "build.log");
      try {
        const mtime = (await Deno.stat(path)).mtime?.getTime() ?? 0;
        // Only a log this build wrote: an older one would mislead.
        if (mtime >= since - 1000 && (!best || mtime > best.mtime)) {
          best = { path, mtime };
        }
      } catch { /* no log in this workspace */ }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return best?.path;
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
export const behavior = {
  type: "@jeremy/mere/recipe",
  version: "2026.11.08.9",
  description: "Read, validate, build, and import merelinux recipes.",
  upgrades: [{
    toVersion: "2026.11.08.9",
    description:
      "Remove the legacy config repository entry left by pre-HOME trust versions.",
    upgradeAttributes: (
      old: Record<string, unknown>,
    ): Record<string, unknown> => old,
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
    validation: {
      description: "Result of `mere dev validate` on one recipe",
      schema: ValidationSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    build: {
      description: "Result of `mere dev build` on one recipe, with its outputs",
      schema: BuildSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    import: {
      description:
        "Result of importing built package outputs into a local repository",
      schema: ImportResultSchema,
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
  files: {
    buildLog: {
      description: "mere's build log for the latest build of a recipe",
      contentType: "text/plain",
      lifetime: "7d",
      garbageCollection: 5,
      streaming: false,
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
        runId: z.string().min(1),
      }),
      execute: async (
        args: { recipe: string; sourceBinding: string; runId: string },
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
        const build = await one(own, "build", `build-${name}`);
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
    validate: {
      description:
        "Run `mere dev validate` on a recipe in a worktree: mere is the " +
        "authority on whether a recipe is acceptable. Records the result, " +
        "then throws if mere rejected it.",
      kind: "action",
      arguments: RecipeCheckoutArgs,
      execute: async (
        args: z.infer<typeof RecipeCheckoutArgs>,
        context: Context,
      ) => {
        const tool = await toolchainOf(context);
        const file = recipeFile(args);
        const result = await runCommand(
          tool.binary,
          ["--root", tool.root, "dev", "validate", file],
          {
            signal: context.signal,
            timeoutMs: 120_000,
            maxOutputBytes: 16_384,
          },
        );
        const output = (result.stderr || result.stdout).trim();
        const handle = await context.writeResource(
          "validation",
          `validation-${args.recipe.split("/")[1]}`,
          {
            recipe: args.recipe,
            path: `recipes/${args.recipe}/recipe.kdl`,
            ok: result.exitCode === 0,
            exitCode: result.exitCode,
            output,
            mereVersion: tool.version,
            durationMs: result.durationMs,
            schemaVersion: 1,
          },
        );
        if (result.exitCode !== 0) {
          throw new Error(
            `mere rejected ${args.recipe}: ${output.split("\n")[0]}`,
          );
        }
        return { dataHandles: [handle] };
      },
    },
    build: {
      description:
        "Run `mere dev build` on a recipe in a worktree, in the isolated " +
        "root. Records the outputs (each package archive, its sha256 and " +
        "size) read from mere's outputs directory, and the build log, then " +
        "throws if the build failed.",
      kind: "action",
      arguments: BuildArgs,
      execute: async (args: z.infer<typeof BuildArgs>, context: Context) => {
        const tool = await toolchainOf(context);
        const file = recipeFile(args);
        const rel = `recipes/${args.recipe}/recipe.kdl`;
        const parsed = parseRecipe(await Deno.readTextFile(file), rel);
        const arch = Deno.build.arch;
        const tuple = `${parsed.name}-${parsed.version}-${parsed.release}`;
        const outputDir = join(
          tool.root,
          "mere",
          "dev",
          "outputs",
          `${tuple}-${arch}`,
        );
        // A stale output from an earlier build must not pass for this one.
        await Deno.remove(outputDir, { recursive: true }).catch((error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        });
        const startedAt = Date.now();
        await removeUninitializedRepository(tool.root, "local");
        await removeLegacyRepositoryConfig(tool.root, "local");
        const globals = GlobalArgs.parse(context.globalArgs);
        const prepared = await prepareSigningKey(
          tool.binary,
          tool.root,
          globals.signingKey,
          context.signal,
        );
        let result;
        try {
          result = await runCommand(
            tool.binary,
            [
              "--root",
              tool.root,
              "dev",
              "build",
              ...(args.noCache ? ["--no-cache"] : []),
              file,
            ],
            {
              signal: context.signal,
              timeoutMs: args.timeoutMinutes * 60_000,
              maxOutputBytes: 65_536,
              env: { HOME: prepared.home },
            },
          );
        } finally {
          await Deno.remove(prepared.keyPath).catch((error) => {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          });
        }
        const tail =
          (result.stdout + (result.stderr ? "\n" + result.stderr : "")).trim();
        const outputs = result.exitCode === 0
          ? await listOutputs(outputDir, parsed.version, parsed.release, arch)
          : [];
        const { failingPhase, errorLine } = result.exitCode === 0
          ? { failingPhase: "", errorLine: "" }
          : diagnose(tail);
        const handles = [];
        const logPath = await latestBuildLog(tool.root, tuple, startedAt);
        if (logPath) {
          const log = await Deno.readTextFile(logPath);
          handles.push(
            await context.createFileWriter("buildLog", parsed.name).writeText(
              log.length > 2_000_000 ? log.slice(-2_000_000) : log,
            ),
          );
        }
        handles.push(
          await context.writeResource("build", `build-${parsed.name}`, {
            recipe: args.recipe,
            name: parsed.name,
            version: parsed.version,
            release: parsed.release,
            arch,
            ok: result.exitCode === 0,
            exitCode: result.exitCode,
            noCache: args.noCache,
            durationMs: result.durationMs,
            failingPhase,
            errorLine,
            outputs,
            logTail: tail.split("\n").slice(-60).join("\n"),
            schemaVersion: 1,
          }),
        );
        if (result.exitCode !== 0) {
          throw new Error(
            `mere dev build failed for ${args.recipe} (exit ${result.exitCode}) in ${
              failingPhase || "an unknown phase"
            }: ${errorLine}`,
          );
        }
        if (outputs.length === 0) {
          throw new Error(
            `build of ${args.recipe} succeeded but produced no packages`,
          );
        }
        return { dataHandles: handles };
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
    importOutputs: {
      description:
        "Import the latest build outputs into a named isolated Mere development " +
        "repository. The signing key is materialized only for this call; " +
        "the repository's public trust metadata remains inside the isolated root.",
      kind: "action",
      arguments: ImportArgs,
      execute: async (
        args: z.infer<typeof ImportArgs>,
        context: Context,
      ) => {
        const started = performance.now();
        const globals = GlobalArgs.parse(context.globalArgs);
        let tool: { binary: string; root: string; version: string } | undefined;
        let prepared:
          | { keyPath: string; home: string; fingerprint: string }
          | undefined;
        let recorded = false;
        try {
          tool = await toolchainOf(context);
          await removeLegacyRepositoryConfig(tool.root, args.repository);
          prepared = await prepareSigningKey(
            tool.binary,
            tool.root,
            globals.signingKey,
            context.signal,
          );
          const result = await runCommand(
            tool.binary,
            [
              "--root",
              tool.root,
              "dev",
              "import",
              args.repository,
              "--key",
              prepared.keyPath,
            ],
            {
              signal: context.signal,
              timeoutMs: 30 * 60 * 1000,
              maxOutputBytes: 64 * 1024,
              env: { HOME: prepared.home },
            },
          );
          const data = {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: performance.now() - started,
            mereVersion: tool.version,
            mereRoot: tool.root,
            repository: args.repository,
            keyFingerprint: prepared.fingerprint,
            success: result.exitCode === 0,
          };
          const handle = await context.writeResource("import", "current", data);
          recorded = true;
          if (result.exitCode !== 0) {
            throw new Error(
              `mere dev import failed for ${args.repository}: ${
                (result.stderr || result.stdout).split("\n")[0] ?? ""
              }`,
            );
          }
          return { dataHandles: [handle] };
        } catch (error) {
          if (!recorded) {
            await context.writeResource("import", "current", {
              exitCode: -1,
              stdout: "",
              stderr: "",
              durationMs: performance.now() - started,
              mereVersion: tool?.version ?? "",
              mereRoot: tool?.root ?? "",
              repository: args.repository,
              keyFingerprint: prepared?.fingerprint ?? "",
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          throw error instanceof Error ? error : new Error(String(error));
        } finally {
          if (prepared?.keyPath) {
            await Deno.remove(prepared.keyPath).catch((error) => {
              if (!(error instanceof Deno.errors.NotFound)) throw error;
            });
          }
        }
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
