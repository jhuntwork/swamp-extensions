// ABOUTME: Executes commands inside a Mere Linux shell namespace.
// ABOUTME: Downloads a fresh mere binary, operates in a dedicated root, captures structured output.
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
    "Mere version to use. 'latest' resolves from Codeberg releases API, or pin e.g. '0.15.2'.",
  ),
  mereRoot: z.string().default("").describe(
    "Dedicated root path for the mere tree. Empty = auto ($SWAMP_REPO_DIR/.swamp/mere-shell/root).",
  ),
  useHostStore: z.boolean().default(false).describe(
    "Symlink host /mere/store into the dedicated root for package cache hits.",
  ),
});

const ResultSchema = z.object({
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number(),
  mereVersion: z.string(),
  mereRoot: z.string(),
  packages: z.array(z.string()),
  command: z.string(),
  success: z.boolean(),
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

/** Optionally link host store into the dedicated root. */
async function linkHostStore(mereRoot: string): Promise<void> {
  const hostStore = "/mere/store";
  const localStore = `${mereRoot}/mere/store`;

  try {
    const hostStat = await Deno.stat(hostStore);
    if (!hostStat.isDirectory) return;
  } catch {
    return;
  }

  try {
    const localStat = await Deno.lstat(localStore);
    if (localStat.isSymlink) return;
    await Deno.remove(localStore, { recursive: true });
  } catch {
    // Doesn't exist yet
  }

  await Deno.symlink(hostStore, localStore);
}

/** Write a temporary profile.kdl from a package list. */
async function writeProfileKdl(
  dir: string,
  packages: string[],
): Promise<string> {
  await Deno.mkdir(dir, { recursive: true });
  const profilePath = `${dir}/profile.kdl`;
  const packageLines = packages.map((p) => `  package "${p}"`).join("\n");
  const content = `profile {\n${packageLines}\n}\n`;
  await Deno.writeTextFile(profilePath, content);
  return profilePath;
}

/** Truncate a string to maxBytes (UTF-8 aware). */
function truncate(str: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  if (bytes.length <= maxBytes) return str;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return decoder.decode(bytes.slice(0, maxBytes)) + "\n... [truncated]";
}

/** Model definition for executing commands inside a Mere shell namespace. */
export const model = {
  type: "@jeremy/mere-shell",
  version: "2026.07.21.2",
  description:
    "Execute commands inside a Mere Linux shell namespace with a dedicated root and freshly-downloaded mere binary.",
  globalArguments: GlobalArgsSchema,
  resources: {
    result: {
      description: "Command execution result with exit code and output",
      schema: ResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    run: {
      description:
        "Run a command inside a mere shell with specified packages available",
      arguments: z.object({
        packages: z.array(z.string()).describe(
          "Packages to make available in the shell (e.g. ['zig', 'cmake'])",
        ),
        command: z.string().describe("Command to execute inside the shell"),
        workdir: z.string().optional().describe(
          "Working directory (bind-mounted into the namespace)",
        ),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: Record<string, unknown>, context: any) => {
        const { packages, command: userCommand, workdir } = args as {
          packages: string[];
          command: string;
          workdir?: string;
        };

        const globalArgs = context.globalArgs;
        const start = performance.now();

        try {
          context.logger.info("Resolving mere version: {version}", {
            version: globalArgs.mereVersion,
          });
          const version = await resolveVersion(globalArgs.mereVersion);
          context.logger.info("Using mere {version}", { version });

          const repoDir = Deno.env.get("SWAMP_REPO_DIR") || Deno.cwd();
          const cacheDir = `${repoDir}/.swamp/mere-shell/bin`;
          const mereRoot = globalArgs.mereRoot ||
            `${repoDir}/.swamp/mere-shell/root`;

          context.logger.info("Ensuring mere binary at {cacheDir}", {
            cacheDir,
          });
          const mereBinary = await ensureBinary(version, cacheDir);

          context.logger.info("Ensuring mere root at {root}", {
            root: mereRoot,
          });
          await ensureRoot(mereRoot, mereBinary);

          if (globalArgs.useHostStore) {
            context.logger.info("Linking host store into dedicated root");
            await linkHostStore(mereRoot);
          }

          const profileDir = `${repoDir}/.swamp/mere-shell/profiles`;
          const profilePath = await writeProfileKdl(profileDir, packages);
          context.logger.info("Profile written: {packages}", {
            packages: packages.join(", "),
          });

          const shellArgs = [
            "--root",
            mereRoot,
            "shell",
            profilePath,
            "--",
            ...userCommand.split(" "),
          ];

          context.logger.info("Executing: mere {args}", {
            args: shellArgs.join(" "),
          });

          const cmdOptions: Deno.CommandOptions = {
            args: shellArgs,
            stdout: "piped",
            stderr: "piped",
            cwd: workdir,
          };

          const cmd = new Deno.Command(mereBinary, cmdOptions);
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
            packages,
            command: userCommand,
            success: output.code === 0,
          };

          context.logger.info(
            "Command finished: exit={code} duration={ms}ms",
            { code: output.code, ms: durationMs },
          );

          const handle = await context.writeResource(
            "result",
            "current",
            result,
          );
          return { dataHandles: [handle] };
        } catch (err) {
          const durationMs = Math.round(performance.now() - start);
          const repoDir_ = Deno.env.get("SWAMP_REPO_DIR") || Deno.cwd();
          const mereRoot_ = globalArgs.mereRoot ||
            `${repoDir_}/.swamp/mere-shell/root`;
          const result = {
            exitCode: -1,
            stdout: "",
            stderr: "",
            durationMs,
            mereVersion: globalArgs.mereVersion,
            mereRoot: mereRoot_,
            packages,
            command: userCommand,
            success: false,
            error: String(err),
          };

          context.logger.error("mere-shell failed: {err}", {
            err: String(err),
          });

          const handle = await context.writeResource(
            "result",
            "current",
            result,
          );
          return { dataHandles: [handle] };
        }
      },
    },
  },
};
