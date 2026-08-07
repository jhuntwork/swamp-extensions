// ABOUTME: Mere recipe development workflow extension.
// ABOUTME: Runs `mere dev build` and `mere dev hash` directly (no shell wrapper).
// ABOUTME: Manages its own dedicated root and binary download.
// deno-lint-ignore-file no-import-prefix
import { z } from "npm:zod@4";

const CODEBERG_API =
  "https://codeberg.org/api/v1/repos/merelinux/mere/releases/latest";
const DOWNLOAD_BASE = "https://codeberg.org/merelinux/mere/releases/download";
const CONFIG_URL = "https://pkgs.merelinux.org/config.kdl";
const KEY_URL = "https://pkgs.merelinux.org/mere.pub";
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB

const GlobalArgsSchema = z.object({
  mereVersion: z.string().default("latest").describe(
    "Mere version to use. 'latest' resolves from Codeberg releases API, or pin e.g. '0.15.2'. Ignored when mereBinaryPath is set.",
  ),
  mereBinaryPath: z.string().default("").describe(
    "Optional path to an existing mere binary. When set, skips download and runs this exact binary (useful for local builds).",
  ),
  mereRoot: z.string().default("").describe(
    "Dedicated root path for the mere tree. Empty = auto ($SWAMP_REPO_DIR/.swamp/mere-dev/root).",
  ),
});

const BuildResultSchema = z.object({
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number(),
  mereVersion: z.string(),
  mereRoot: z.string(),
  recipePath: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
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

/** Resolve the actual mere version when "latest" is requested. */
async function resolveVersion(version: string): Promise<string> {
  if (version !== "latest") return version;
  const res = await fetch(CODEBERG_API);
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

/** Ensure the mere binary is downloaded and executable. Returns path to binary. */
async function ensureBinary(
  version: string,
  cacheDir: string,
): Promise<string> {
  const arch = getArch();
  const binaryName = `mere-${version}-linux-${arch}`;
  const binaryPath = `${cacheDir}/${binaryName}`;

  try {
    const stat = await Deno.stat(binaryPath);
    if (stat.isFile) return binaryPath;
  } catch {
    // Not cached yet — download
  }

  await Deno.mkdir(cacheDir, { recursive: true });
  const url = `${DOWNLOAD_BASE}/v${version}/${binaryName}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to download mere ${version} for ${arch}: ${res.status} from ${url}`,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  await Deno.writeFile(binaryPath, bytes, { mode: 0o755 });
  return binaryPath;
}

/** Ensure the dedicated mere root is initialized with config and keys. */
async function ensureRoot(mereRoot: string, mereBinary: string): Promise<void> {
  const mereDir = `${mereRoot}/mere`;
  const storeDir = `${mereDir}/store`;
  const configPath = `${mereDir}/config.kdl`;
  const keysDir = `${mereDir}/keys`;
  const keyPath = `${keysDir}/mere.pub`;

  // Create store if missing
  try {
    await Deno.stat(storeDir);
  } catch {
    const cmd = new Deno.Command(mereBinary, {
      args: ["--root", mereRoot, "store", "init"],
    });
    const output = await cmd.output();
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
  await ensureRoot(mereRoot, mereBinary);

  return { mereRoot, mereBinary, version };
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
  version: "2026.08.07.3",
  description:
    "Mere recipe development workflow: build recipes, hash sources, and read build logs. " +
    "Invokes mere directly without a shell wrapper and supports local binary overrides.",
  globalArguments: GlobalArgsSchema,
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
  },
  methods: {
    build: {
      description:
        "Build a recipe using `mere dev build`. Manages its own namespace — do not wrap in mere shell.",
      arguments: z.object({
        recipe: z.string().describe(
          "Absolute path to the recipe.kdl file to build",
        ),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: Record<string, unknown>, context: any) => {
        const { recipe } = args as { recipe: string };
        const globalArgs = context.globalArgs;
        const start = performance.now();

        try {
          const { mereRoot, mereBinary, version } = await setup(
            globalArgs,
            context.logger,
          );

          const buildArgs = ["--root", mereRoot, "dev", "build", recipe];
          context.logger.info("Executing: mere {args}", {
            args: buildArgs.join(" "),
          });

          const cmd = new Deno.Command(mereBinary, {
            args: buildArgs,
            stdout: "piped",
            stderr: "piped",
          });
          const output = await cmd.output();
          const durationMs = Math.round(performance.now() - start);

          const stdout = truncate(
            new TextDecoder().decode(output.stdout),
            MAX_OUTPUT_BYTES,
          );
          const stderr = truncate(
            new TextDecoder().decode(output.stderr),
            MAX_OUTPUT_BYTES,
          );

          const result = {
            exitCode: output.code,
            stdout,
            stderr,
            durationMs,
            mereVersion: version,
            mereRoot,
            recipePath: recipe,
            success: output.code === 0,
          };

          context.logger.info(
            "Build finished: exit={code} duration={ms}ms",
            { code: output.code, ms: durationMs },
          );

          const handle = await context.writeResource(
            "build-result",
            "current",
            result,
          );
          return { dataHandles: [handle] };
        } catch (err) {
          const durationMs = Math.round(performance.now() - start);
          const repoDir = Deno.env.get("SWAMP_REPO_DIR") || Deno.cwd();
          const mereRoot = globalArgs.mereRoot ||
            `${repoDir}/.swamp/mere-dev/root`;
          const result = {
            exitCode: -1,
            stdout: "",
            stderr: "",
            durationMs,
            mereVersion: globalArgs.mereVersion,
            mereRoot,
            recipePath: recipe,
            success: false,
            error: String(err),
          };

          context.logger.error("mere-dev build failed: {err}", {
            err: String(err),
          });

          const handle = await context.writeResource(
            "build-result",
            "current",
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
            const dlCmd = new Deno.Command("curl", {
              args: ["-sL", "-o", filePath, source],
            });
            const dlOutput = await dlCmd.output();
            if (!dlOutput.success) {
              throw new Error(
                `Download failed: ${new TextDecoder().decode(dlOutput.stderr)}`,
              );
            }
          }

          context.logger.info("Computing blake3 hash for {path}", {
            path: filePath,
          });
          const hashCmd = new Deno.Command(mereBinary, {
            args: ["dev", "hash", filePath],
            stdout: "piped",
            stderr: "piped",
          });
          const hashOutput = await hashCmd.output();

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
            "current",
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
            "current",
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
              "current",
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
            "current",
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
            "current",
            result,
          );
          return { dataHandles: [handle] };
        }
      },
    },
  },
};
