// ABOUTME: Mere recipe development workflow extension.
// ABOUTME: Runs `mere dev build` and `mere dev hash` directly (no shell wrapper).
// ABOUTME: Manages its own dedicated root and binary download.
// deno-lint-ignore-file no-import-prefix
import { z } from "npm:zod@4.4.3";
import { join } from "node:path";
import { parseRecipe } from "./lib/kdl.ts";
import {
  diagnose,
  findOutputDir,
  latestBuildLog,
  listOutputs,
  removeLegacyRepositoryConfig,
  removeUninitializedRepository,
} from "./lib/build.ts";

const GITHUB_API =
  "https://api.github.com/repos/jhuntwork/mere/releases/latest";
const DOWNLOAD_BASE = "https://github.com/jhuntwork/mere/releases/download";
const CHECKSUMS_FILE = "SHA256SUMS";
const CONFIG_URL = "https://pkgs.merelinux.org/config.kdl";
const KEY_URL = "https://pkgs.merelinux.org/mere.pub";
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB

/** Run one subprocess and bind it to the model cancellation signal. */
export async function runCommand(
  command: string,
  options: Deno.CommandOptions,
  signal?: AbortSignal,
): Promise<Deno.CommandOutput> {
  // swamp-quality-ignore deno-command
  return await new Deno.Command(command, { ...options, signal }).output();
}

const GlobalArgsSchema = z.object({
  mereVersion: z.string().default("latest").describe(
    "Mere version to use. 'latest' resolves from the GitHub releases API, or pin e.g. '0.21.0'. Ignored when mereBinaryPath is set.",
  ),
  mereBinaryPath: z.string().default("").describe(
    "Optional path to an existing mere binary. When set, skips download and runs this exact binary (useful for local builds).",
  ),
  mereRoot: z.string().default("").describe(
    "Dedicated root path for the mere tree. Empty = auto ($SWAMP_REPO_DIR/.swamp/mere-dev/root).",
  ),
});

const RecipeName = z.string().regex(
  /^[a-z0-9][a-z0-9._+-]*\/[a-z0-9][a-z0-9._+-]*$/i,
  "recipe must be <category>/<name>, for example core/zlib-ng",
);

const RecipeArgs = z.object({
  recipe: RecipeName,
  checkoutPath: z.string().min(1).refine(
    (value) => value.startsWith("/"),
    "checkoutPath must be an absolute path",
  ).describe(
    "Absolute path of the checkout or per-run worktree that holds recipes/<category>/<name>/recipe.kdl.",
  ),
});

const BuildArgs = RecipeArgs.extend({
  noCache: z.boolean().default(true).describe("Pass --no-cache, as CI does."),
  timeoutMinutes: z.number().int().min(1).max(240).default(60),
});

const OutputSchema = z.object({
  fileName: z.string(),
  path: z.string(),
  package: z.string(),
  contentId: z.string().describe("The hash in mere's archive file name"),
  sha256: z.string(),
  bytes: z.number().int().nonnegative(),
});

const ValidationResultSchema = z.object({
  recipe: z.string(),
  recipePath: z.string(),
  ok: z.boolean(),
  success: z.boolean(),
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number(),
  mereVersion: z.string(),
  mereRoot: z.string(),
  error: z.string().optional(),
  schemaVersion: z.literal(1),
});

const BuildResultSchema = z.object({
  recipe: z.string(),
  recipePath: z.string(),
  name: z.string(),
  version: z.string(),
  release: z.number().int(),
  arch: z.string().describe("The directory suffix mere used for the outputs"),
  ok: z.boolean(),
  success: z.boolean(),
  exitCode: z.number(),
  noCache: z.boolean(),
  durationMs: z.number(),
  failingPhase: z.string().describe("Empty on success"),
  errorLine: z.string().describe(
    "mere's first error message, empty on success",
  ),
  outputs: z.array(OutputSchema),
  logTail: z.string(),
  mereVersion: z.string(),
  mereRoot: z.string(),
  error: z.string().optional(),
  schemaVersion: z.literal(1),
});

const HashResultSchema = z.object({
  blake3: z.string(),
  source: z.string(),
  mereRoot: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});

const DevLogResultSchema = z.object({
  found: z.boolean(),
  path: z.string(),
  content: z.string(),
  mereRoot: z.string(),
  error: z.string().optional(),
});

const SigningKeyStatusSchema = z.object({
  ready: z.boolean(),
  generated: z.boolean(),
  keyPath: z.string(),
  command: z.string(),
  error: z.string().optional(),
});

const ImportResultSchema = z.object({
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number(),
  mereVersion: z.string(),
  mereRoot: z.string(),
  repository: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});

/** Resolve the actual mere version when "latest" is requested. */
async function resolveVersion(version: string): Promise<string> {
  if (version !== "latest") return version;
  const res = await fetch(GITHUB_API);
  if (!res.ok) {
    throw new Error(`Failed to fetch latest mere version: ${res.status}`);
  }
  const data = await res.json();
  const tag = data.tag_name as string;
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

/** Get the platform architecture string for mere binary downloads. */
function getArch(): string {
  return Deno.build.arch;
}

/** Parse a SHA256SUMS entry for one exact release asset. */
export function parseSha256Sums(text: string, fileName: string): string {
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match && match[2].trim() === fileName) return match[1].toLowerCase();
  }
  throw new Error(`SHA256SUMS has no entry for ${fileName}`);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function fetchBytes(
  url: string,
  description: string,
): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${description}: ${response.status} from ${url}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Ensure the mere binary is downloaded and matches the release checksum. */
async function ensureBinary(
  version: string,
  cacheDir: string,
): Promise<string> {
  const arch = getArch();
  const binaryName = `mere-${version}-linux-${arch}`;
  const binaryPath = `${cacheDir}/${binaryName}`;
  const baseUrl = `${DOWNLOAD_BASE}/v${version}`;
  const binaryUrl = `${baseUrl}/${binaryName}`;
  const checksums = new TextDecoder().decode(
    await fetchBytes(`${baseUrl}/${CHECKSUMS_FILE}`, CHECKSUMS_FILE),
  );
  const expected = parseSha256Sums(checksums, binaryName);

  let bytes: Uint8Array;
  let needsWrite = false;
  try {
    bytes = await Deno.readFile(binaryPath);
  } catch {
    bytes = await fetchBytes(binaryUrl, `mere ${version} for ${arch}`);
    needsWrite = true;
  }

  if (await sha256Hex(bytes) !== expected) {
    bytes = await fetchBytes(binaryUrl, `mere ${version} for ${arch}`);
    if (await sha256Hex(bytes) !== expected) {
      throw new Error(
        `SHA-256 mismatch for mere ${version} ${arch}; refusing to cache it`,
      );
    }
    needsWrite = true;
  }

  if (needsWrite) {
    await Deno.mkdir(cacheDir, { recursive: true });
    await Deno.writeFile(binaryPath, bytes, { mode: 0o755 });
  }
  return binaryPath;
}

/** Ensure the dedicated mere root is initialized with config and keys. */
async function ensureRoot(
  mereRoot: string,
  mereBinary: string,
  signal?: AbortSignal,
): Promise<void> {
  const mereDir = `${mereRoot}/mere`;
  const storeDir = `${mereDir}/store`;
  const configPath = `${mereDir}/config.kdl`;
  const keysDir = `${mereDir}/keys`;
  const keyPath = `${keysDir}/mere.pub`;

  // Create store if missing
  try {
    await Deno.stat(storeDir);
  } catch {
    const output = await runCommand(mereBinary, {
      args: ["--root", mereRoot, "store", "init"],
    }, signal);
    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr);
      throw new Error(`mere store init failed: ${stderr}`);
    }
  }

  // Ensure config
  try {
    await Deno.stat(configPath);
  } catch {
    const res = await fetch(CONFIG_URL);
    if (res.ok) {
      const text = await res.text();
      await Deno.writeTextFile(configPath, text);
    }
  }

  // Ensure key
  try {
    await Deno.stat(keyPath);
  } catch {
    await Deno.mkdir(keysDir, { recursive: true });
    const res = await fetch(KEY_URL);
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      await Deno.writeFile(keyPath, bytes);
    }
  }
}

/** Return Mere's standard per-user development signing-key path. */
export function developmentSigningKeyPath(home: string): string {
  return `${home}/.mere/keys/mere.key`;
}

function keyGenerationCommand(mereBinary: string): string {
  return `${mereBinary} dev key generate`;
}

async function signingKeyStatus(): Promise<
  { ready: boolean; keyPath: string }
> {
  const home = Deno.env.get("HOME");
  if (!home) {
    throw new Error(
      "Cannot locate the development signing key because HOME is unset",
    );
  }

  const keyPath = developmentSigningKeyPath(home);
  try {
    const stat = await Deno.stat(keyPath);
    return { ready: stat.isFile, keyPath };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { ready: false, keyPath };
    throw new Error(
      `Cannot inspect development signing key ${keyPath}: ${error}`,
    );
  }
}

async function requireDevelopmentSigningKey(
  mereBinary: string,
): Promise<string> {
  const status = await signingKeyStatus();
  if (status.ready) return status.keyPath;
  throw new Error(
    `Development signing key is missing: ${status.keyPath}. ` +
      `Create it explicitly with \`${
        keyGenerationCommand(mereBinary)
      }\`, then retry the build.`,
  );
}

/** Truncate a string to maxBytes (UTF-8 aware). */
function truncate(str: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  if (bytes.length <= maxBytes) return str;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return decoder.decode(bytes.slice(0, maxBytes)) + "\n... [truncated]";
}

/** Resolve mereRoot and ensure infrastructure is ready. Returns {mereRoot, mereBinary, version}. */
async function setup(
  globalArgs: { mereVersion: string; mereBinaryPath: string; mereRoot: string },
  // deno-lint-ignore no-explicit-any
  logger: any,
  signal?: AbortSignal,
): Promise<{ mereRoot: string; mereBinary: string; version: string }> {
  logger.info("Resolving mere version: {version}", {
    version: globalArgs.mereVersion,
  });
  const repoDir = Deno.env.get("SWAMP_REPO_DIR") || Deno.cwd();
  const mereRoot = globalArgs.mereRoot ||
    `${repoDir}/.swamp/mere-dev/root`;

  let mereBinary: string;
  let version: string;
  if (globalArgs.mereBinaryPath) {
    try {
      const stat = await Deno.stat(globalArgs.mereBinaryPath);
      if (!stat.isFile) throw new Error("path is not a regular file");
    } catch (error) {
      throw new Error(
        `Configured mereBinaryPath is not usable: ${globalArgs.mereBinaryPath}: ${error}`,
      );
    }
    mereBinary = globalArgs.mereBinaryPath;
    version = "local";
    logger.info("Using local mere binary: {path}", { path: mereBinary });
  } else {
    version = await resolveVersion(globalArgs.mereVersion);
    logger.info("Using mere {version}", { version });
    const cacheDir = `${repoDir}/.swamp/mere-dev/bin`;
    logger.info("Ensuring mere binary at {cacheDir}", { cacheDir });
    mereBinary = await ensureBinary(version, cacheDir);
  }

  logger.info("Ensuring mere root at {root}", { root: mereRoot });
  await ensureRoot(mereRoot, mereBinary, signal);

  return { mereRoot, mereBinary, version };
}

/** The recipe.kdl for `<category>/<name>` inside a checkout or worktree. */
export function recipeFile(checkoutPath: string, recipe: string): string {
  if (!checkoutPath.startsWith("/")) {
    throw new Error("checkoutPath must be an absolute path");
  }
  return join(checkoutPath, "recipes", recipe, "recipe.kdl");
}

/** First non-empty line of mere's output, for an error message. */
export function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

/** Remove earlier exports of this recipe tuple so a stale one cannot pass. */
async function removeStaleOutputs(
  outputsRoot: string,
  tuple: string,
): Promise<void> {
  try {
    for await (const entry of Deno.readDir(outputsRoot)) {
      if (entry.isDirectory && entry.name.startsWith(`${tuple}-`)) {
        await Deno.remove(join(outputsRoot, entry.name), { recursive: true });
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/** Run mere with a timeout and a bounded tail of each stream. */
async function runBounded(
  binary: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}> {
  const start = performance.now();
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
    : AbortSignal.timeout(options.timeoutMs);
  const output = await runCommand(binary, {
    args,
    stdout: "piped",
    stderr: "piped",
  }, signal);
  return {
    exitCode: output.code,
    stdout: truncate(new TextDecoder().decode(output.stdout), MAX_OUTPUT_BYTES),
    stderr: truncate(new TextDecoder().decode(output.stderr), MAX_OUTPUT_BYTES),
    durationMs: Math.round(performance.now() - start),
  };
}

/** Extract the canonical 64-character BLAKE3 digest from `mere dev hash` output. */
export function parseBlake3Output(output: string): string {
  const match = output.match(/(?:^|\n)\s*([0-9a-f]{64})(?:\s|$)/i);
  if (!match) {
    throw new Error(
      `Could not parse a BLAKE3 digest from mere output: ${output}`,
    );
  }
  return match[1].toLowerCase();
}

/** Model definition for mere recipe development workflows. */
export const model = {
  type: "@jeremy/mere-dev",
  version: "2026.11.13.5",
  description:
    "Mere recipe development workflow: build recipes, hash sources, and read build logs. " +
    "Invokes mere directly without a shell wrapper and supports local binary overrides.",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.08.17.1",
      description:
        "Add explicit signing-key readiness and typed recipe validation/import operations. No globalArguments changes.",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.08.17.2",
      description:
        "Propagate model cancellation into every Mere subprocess launch.",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.08.23.1",
      description:
        "Package the canonical MereLinux recipe validation and delivery workflow. No globalArguments changes.",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.08.23.2",
      description:
        "Resolve and download hosted Mere releases from GitHub so recipe validation matches installed-profile smoke tests.",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.11.10.1",
      description:
        "Verify downloaded Mere release binaries against SHA256SUMS and pin extension dependencies. Global arguments unchanged.",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.11.13.1",
      description:
        "Delivery workflow passes change facts straight to the GitHub adapter and no longer needs a change-packet binding. Global arguments unchanged.",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.11.13.3",
      description:
        "Delivery workflow hands the change to @jeremy/mere-delivery for the commit check, push, and pull request. Global arguments unchanged.",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.11.13.5",
      description:
        "validate, build and importOutputs fail the method when mere fails, after recording the result. validate and build take recipe plus checkoutPath, and build records packages, the failing phase and the build log. Global arguments unchanged.",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
  ],

  resources: {
    "build-result": {
      description: "Recipe build result with exit code and output",
      schema: BuildResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "hash-result": {
      description: "Source hash result",
      schema: HashResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "dev-log": {
      description: "Dev build log content",
      schema: DevLogResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "signing-key-status": {
      description: "Development signing-key readiness",
      schema: SigningKeyStatusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "validation-result": {
      description: "Recipe validation result",
      schema: ValidationResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "import-result": {
      description: "Development repository import result",
      schema: ImportResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  files: {
    "build-log": {
      description: "mere's build log for the latest build of a recipe",
      contentType: "text/plain",
      lifetime: "7d",
      garbageCollection: 5,
      streaming: false,
    },
  },
  methods: {
    validate: {
      description:
        "Validate a recipe in a checkout or worktree with `mere dev validate`, without building it. Records the result, then fails if mere rejected the recipe.",
      arguments: RecipeArgs,
      // deno-lint-ignore no-explicit-any
      execute: async (args: Record<string, unknown>, context: any) => {
        const { recipe, checkoutPath } = RecipeArgs.parse(args);
        const file = recipeFile(checkoutPath, recipe);
        const start = performance.now();
        const { mereRoot, mereBinary, version } = await setup(
          context.globalArgs,
          context.logger,
          context.signal,
        );
        const output = await runCommand(mereBinary, {
          args: ["--root", mereRoot, "dev", "validate", file],
          stdout: "piped",
          stderr: "piped",
        }, context.signal);
        const stdout = truncate(
          new TextDecoder().decode(output.stdout),
          MAX_OUTPUT_BYTES,
        );
        const stderr = truncate(
          new TextDecoder().decode(output.stderr),
          MAX_OUTPUT_BYTES,
        );
        const handle = await context.writeResource(
          "validation-result",
          "validation-result",
          {
            recipe,
            recipePath: file,
            ok: output.success,
            success: output.success,
            exitCode: output.code,
            stdout,
            stderr,
            durationMs: Math.round(performance.now() - start),
            mereVersion: version,
            mereRoot,
            schemaVersion: 1,
          },
        );
        if (!output.success) {
          throw new Error(
            `mere dev validate rejected ${recipe}: ${
              firstLine(stderr || stdout)
            }`,
          );
        }
        return { dataHandles: [handle] };
      },
    },
    build: {
      description:
        "Build a recipe in a checkout or worktree with `mere dev build`, in the dedicated root. Records the package archives (name, sha256, size), the failing phase and error line on failure, and mere's build log. Fails if the build failed or produced no packages. Manages its own namespace; do not wrap it in mere shell.",
      arguments: BuildArgs,
      // deno-lint-ignore no-explicit-any
      execute: async (args: Record<string, unknown>, context: any) => {
        const { recipe, checkoutPath, noCache, timeoutMinutes } = BuildArgs
          .parse(args);
        const file = recipeFile(checkoutPath, recipe);
        const rel = `recipes/${recipe}/recipe.kdl`;
        const parsed = parseRecipe(await Deno.readTextFile(file), rel);
        const tuple = `${parsed.name}-${parsed.version}-${parsed.release}`;
        const start = performance.now();
        const { mereRoot, mereBinary, version } = await setup(
          context.globalArgs,
          context.logger,
          context.signal,
        );
        await requireDevelopmentSigningKey(mereBinary);
        const outputsRoot = join(mereRoot, "mere", "dev", "outputs");
        // A stale export from an earlier build must not pass for this one.
        await removeStaleOutputs(outputsRoot, tuple);
        await removeUninitializedRepository(mereRoot, "local");
        await removeLegacyRepositoryConfig(mereRoot, "local");
        const buildArgs = [
          "--root",
          mereRoot,
          "dev",
          "build",
          ...(noCache ? ["--no-cache"] : []),
          file,
        ];
        context.logger.info("Executing: mere {args}", {
          args: buildArgs.join(" "),
        });
        const result = await runBounded(mereBinary, buildArgs, {
          signal: context.signal,
          timeoutMs: timeoutMinutes * 60_000,
        });
        const tail =
          (result.stdout + (result.stderr ? "\n" + result.stderr : ""))
            .trim();
        const outputDir = result.exitCode === 0
          ? await findOutputDir(outputsRoot, tuple)
          : undefined;
        const outputs = outputDir ? await listOutputs(outputDir) : [];
        const { failingPhase, errorLine } = result.exitCode === 0
          ? { failingPhase: "", errorLine: "" }
          : diagnose(tail);
        const handles = [];
        const logPath = await latestBuildLog(
          mereRoot,
          tuple,
          Date.now() - result.durationMs,
        );
        if (logPath) {
          const log = await Deno.readTextFile(logPath);
          handles.push(
            await context.createFileWriter("build-log", parsed.name).writeText(
              log.length > 2_000_000 ? log.slice(-2_000_000) : log,
            ),
          );
        }
        const ok = result.exitCode === 0 && outputs.length > 0;
        handles.push(
          await context.writeResource("build-result", "build-result", {
            recipe,
            recipePath: file,
            name: parsed.name,
            version: parsed.version,
            release: parsed.release,
            arch: outputDir
              ? outputDir.split("/").pop()!.slice(tuple.length + 1)
              : "",
            ok,
            success: ok,
            exitCode: result.exitCode,
            noCache,
            durationMs: Math.round(performance.now() - start),
            failingPhase,
            errorLine,
            outputs,
            logTail: tail.split("\n").slice(-60).join("\n"),
            mereVersion: version,
            mereRoot,
            schemaVersion: 1,
          }),
        );
        if (result.exitCode !== 0) {
          throw new Error(
            `mere dev build failed for ${recipe} (exit ${result.exitCode}) in ${
              failingPhase || "an unknown phase"
            }: ${errorLine}`,
          );
        }
        if (outputs.length === 0) {
          throw new Error(
            `build of ${recipe} succeeded but produced no packages`,
          );
        }
        return { dataHandles: handles };
      },
    },
    importOutputs: {
      description:
        "Import the dedicated root's built package archives into a named local development repository, signed with the development key. Records the result, then fails if the import failed.",
      arguments: z.object({
        repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
          .default("local").describe(
            "Development repository name under the dedicated Mere root",
          ),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: Record<string, unknown>, context: any) => {
        const { repository } = args as { repository: string };
        const start = performance.now();
        const { mereRoot, mereBinary, version } = await setup(
          context.globalArgs,
          context.logger,
          context.signal,
        );
        await requireDevelopmentSigningKey(mereBinary);
        await removeLegacyRepositoryConfig(mereRoot, repository);
        const output = await runCommand(mereBinary, {
          args: ["--root", mereRoot, "dev", "import", repository, "--force"],
          stdout: "piped",
          stderr: "piped",
        }, context.signal);
        const handle = await context.writeResource(
          "import-result",
          "import-result",
          {
            exitCode: output.code,
            stdout: truncate(
              new TextDecoder().decode(output.stdout),
              MAX_OUTPUT_BYTES,
            ),
            stderr: truncate(
              new TextDecoder().decode(output.stderr),
              MAX_OUTPUT_BYTES,
            ),
            durationMs: Math.round(performance.now() - start),
            mereVersion: version,
            mereRoot,
            repository,
            success: output.success,
          },
        );
        if (!output.success) {
          throw new Error(
            `mere dev import failed for ${repository}: ${
              firstLine(
                new TextDecoder().decode(output.stderr) ||
                  new TextDecoder().decode(output.stdout),
              )
            }`,
          );
        }
        return { dataHandles: [handle] };
      },
    },
    keyStatus: {
      description:
        "Check whether the standard development signing key exists. Does not create or expose private key material.",
      arguments: z.object({}),
      // deno-lint-ignore no-explicit-any
      execute: async (_args: Record<string, unknown>, context: any) => {
        const globalArgs = context.globalArgs;

        try {
          const { mereBinary } = await setup(
            globalArgs,
            context.logger,
            context.signal,
          );
          const status = await signingKeyStatus();
          const result = {
            ...status,
            generated: false,
            command: keyGenerationCommand(mereBinary),
          };
          const handle = await context.writeResource(
            "signing-key-status",
            "signing-key-status",
            result,
          );
          return { dataHandles: [handle] };
        } catch (err) {
          const home = Deno.env.get("HOME") || "~";
          const result = {
            ready: false,
            generated: false,
            keyPath: developmentSigningKeyPath(home),
            command: "mere dev key generate",
            error: String(err),
          };
          const handle = await context.writeResource(
            "signing-key-status",
            "signing-key-status",
            result,
          );
          return { dataHandles: [handle] };
        }
      },
    },
    generateSigningKey: {
      description:
        "Explicitly generate the standard Ed25519 development signing key when absent. This writes private key material to ~/.mere/keys/mere.key.",
      arguments: z.object({}),
      // deno-lint-ignore no-explicit-any
      execute: async (_args: Record<string, unknown>, context: any) => {
        const globalArgs = context.globalArgs;
        try {
          const { mereBinary } = await setup(
            globalArgs,
            context.logger,
            context.signal,
          );
          const before = await signingKeyStatus();
          if (before.ready) {
            const handle = await context.writeResource(
              "signing-key-status",
              "signing-key-status",
              {
                ...before,
                generated: false,
                command: keyGenerationCommand(mereBinary),
              },
            );
            return { dataHandles: [handle] };
          }

          const output = await runCommand(mereBinary, {
            args: ["dev", "key", "generate"],
            stdout: "piped",
            stderr: "piped",
          }, context.signal);
          if (!output.success) {
            throw new Error(
              `Development signing-key generation failed: ${
                new TextDecoder().decode(output.stderr)
              }`,
            );
          }

          const after = await signingKeyStatus();
          if (!after.ready) {
            throw new Error(
              `Development signing-key generation reported success but did not create ${after.keyPath}`,
            );
          }
          const handle = await context.writeResource(
            "signing-key-status",
            "signing-key-status",
            {
              ...after,
              generated: true,
              command: keyGenerationCommand(mereBinary),
            },
          );
          return { dataHandles: [handle] };
        } catch (err) {
          const home = Deno.env.get("HOME") || "~";
          const result = {
            ready: false,
            generated: false,
            keyPath: developmentSigningKeyPath(home),
            command: "mere dev key generate",
            error: String(err),
          };
          const handle = await context.writeResource(
            "signing-key-status",
            "signing-key-status",
            result,
          );
          return { dataHandles: [handle] };
        }
      },
    },
    hash: {
      description:
        "Compute the blake3 hash of a local file or download a URL and hash it. " +
        "Uses `mere dev hash`.",
      arguments: z.object({
        source: z.string().describe(
          "Local file path or URL to download and hash",
        ),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: Record<string, unknown>, context: any) => {
        const { source } = args as { source: string };
        const globalArgs = context.globalArgs;

        try {
          const { mereRoot, mereBinary } = await setup(
            globalArgs,
            context.logger,
            context.signal,
          );

          let filePath = source;

          // If it's a URL, download it first
          if (source.startsWith("http://") || source.startsWith("https://")) {
            const repoDir = Deno.env.get("SWAMP_REPO_DIR") || Deno.cwd();
            const downloadDir = `${repoDir}/.swamp/mere-dev/downloads`;
            await Deno.mkdir(downloadDir, { recursive: true });
            const filename = source.split("/").pop() ?? "source";
            filePath = `${downloadDir}/${filename}`;

            context.logger.info("Downloading {url}", { url: source });
            const dlOutput = await runCommand("curl", {
              args: ["-sL", "-o", filePath, source],
            }, context.signal);
            if (!dlOutput.success) {
              throw new Error(
                `Download failed: ${new TextDecoder().decode(dlOutput.stderr)}`,
              );
            }
          }

          context.logger.info("Computing blake3 hash for {path}", {
            path: filePath,
          });
          const hashOutput = await runCommand(mereBinary, {
            args: ["dev", "hash", filePath],
            stdout: "piped",
            stderr: "piped",
          }, context.signal);

          if (!hashOutput.success) {
            throw new Error(
              `mere dev hash failed: ${
                new TextDecoder().decode(hashOutput.stderr)
              }`,
            );
          }

          const blake3 = parseBlake3Output(
            new TextDecoder().decode(hashOutput.stdout),
          );

          const result = {
            blake3,
            source,
            mereRoot,
            success: true,
          };

          context.logger.info("Hash computed: {blake3}", { blake3 });

          const handle = await context.writeResource(
            "hash-result",
            "hash-result",
            result,
          );
          return { dataHandles: [handle] };
        } catch (err) {
          const repoDir = Deno.env.get("SWAMP_REPO_DIR") || Deno.cwd();
          const mereRoot = globalArgs.mereRoot ||
            `${repoDir}/.swamp/mere-dev/root`;
          const result = {
            blake3: "",
            source,
            mereRoot,
            success: false,
            error: String(err),
          };

          context.logger.error("mere-dev hash failed: {err}", {
            err: String(err),
          });

          const handle = await context.writeResource(
            "hash-result",
            "hash-result",
            result,
          );
          return { dataHandles: [handle] };
        }
      },
    },
    devLog: {
      description: "Read the most recent build log from the dev workspace",
      arguments: z.object({
        recipe: z.string().optional().describe(
          "Recipe name to filter for (e.g. 'dinit'). If omitted, returns the most recent log.",
        ),
        tail: z.number().optional().describe(
          "Return only the last N lines (useful for large logs)",
        ),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: Record<string, unknown>, context: any) => {
        const { recipe, tail } = args as {
          recipe?: string;
          tail?: number;
        };

        const globalArgs = context.globalArgs;
        const repoDir = Deno.env.get("SWAMP_REPO_DIR") || Deno.cwd();
        const mereRoot = globalArgs.mereRoot ||
          `${repoDir}/.swamp/mere-dev/root`;
        const buildDir = `${mereRoot}/mere/dev/build`;

        try {
          const entries: { name: string; mtime: number; path: string }[] = [];

          for await (const entry of Deno.readDir(buildDir)) {
            if (!entry.isDirectory) continue;
            if (recipe && !entry.name.startsWith(recipe)) continue;

            const logPath = `${buildDir}/${entry.name}/build.log`;
            try {
              const stat = await Deno.stat(logPath);
              entries.push({
                name: entry.name,
                mtime: stat.mtime?.getTime() ?? 0,
                path: logPath,
              });
            } catch {
              // No build.log in this directory, skip
            }
          }

          if (entries.length === 0) {
            const result = {
              found: false,
              path: buildDir,
              content: "",
              mereRoot,
              error: `No build.log found${
                recipe ? ` for recipe '${recipe}'` : ""
              } in ${buildDir}`,
            };
            const handle = await context.writeResource(
              "dev-log",
              "dev-log",
              result,
            );
            return { dataHandles: [handle] };
          }

          // Sort by mtime descending, take the most recent
          entries.sort((a, b) => b.mtime - a.mtime);
          const latest = entries[0];

          let content = await Deno.readTextFile(latest.path);

          if (tail && tail > 0) {
            const lines = content.split("\n");
            content = lines.slice(-tail).join("\n");
          }

          content = truncate(content, MAX_OUTPUT_BYTES);

          const result = {
            found: true,
            path: latest.path,
            content,
            mereRoot,
          };

          context.logger.info("Read build log: {path} ({len} chars)", {
            path: latest.path,
            len: content.length,
          });

          const handle = await context.writeResource(
            "dev-log",
            "dev-log",
            result,
          );
          return { dataHandles: [handle] };
        } catch (err) {
          const result = {
            found: false,
            path: buildDir,
            content: "",
            mereRoot,
            error: String(err),
          };

          context.logger.error("devLog failed: {err}", {
            err: String(err),
          });

          const handle = await context.writeResource(
            "dev-log",
            "dev-log",
            result,
          );
          return { dataHandles: [handle] };
        }
      },
    },
  },
};
