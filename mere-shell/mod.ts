// ABOUTME: Executes typed commands inside a Mere Linux shell namespace.
// ABOUTME: Verifies downloaded Mere binaries and propagates model cancellation.
// deno-lint-ignore-file no-import-prefix
import { z } from "npm:zod@4";

const CODEBERG_API =
  "https://api.github.com/repos/jhuntwork/mere/releases/latest";
const DOWNLOAD_BASE = "https://github.com/jhuntwork/mere/releases/download";
const CONFIG_URL = "https://pkgs.merelinux.org/config.kdl";
const KEY_URL = "https://pkgs.merelinux.org/mere.pub";
const MAX_OUTPUT_BYTES = 1024 * 1024;

const GlobalArgsSchema = z.object({
  mereVersion: z.string().default("latest").describe(
    "Mere version to use. 'latest' resolves from Codeberg releases API, or pin e.g. '0.18.2'.",
  ),
  mereSHA256: z.string().default("").describe(
    "Optional expected SHA-256 for the selected Mere binary. When empty, use the release SHA256SUMS asset.",
  ),
  mereRoot: z.string().default("").describe(
    "Dedicated root path for the mere tree. Empty = auto ($SWAMP_REPO_DIR/.swamp/mere-shell/root).",
  ),
  useHostStore: z.boolean().default(false).describe(
    "If true, symlinks host /mere/store into the dedicated root for cache hits.",
  ),
});

const ResultSchema = z.object({
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  durationMs: z.number(),
  mereVersion: z.string(),
  mereRoot: z.string(),
  packages: z.array(z.string()),
  argv: z.array(z.string()),
  success: z.boolean(),
  error: z.string().optional(),
});

/** Run one subprocess and bind it to the model cancellation signal. */
export async function runCommand(
  command: string,
  options: Deno.CommandOptions,
  signal?: AbortSignal,
): Promise<Deno.CommandOutput> {
  return await new Deno.Command(command, { ...options, signal }).output();
}

/** Parse the SHA-256 for one release binary from a SHA256SUMS manifest. */
export function parseSHA256SUMS(sums: string, binaryName: string): string {
  for (const line of sums.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2) continue;
    if (fields[1].replace(/^\*/, "") !== binaryName) continue;
    if (!/^[a-fA-F0-9]{64}$/.test(fields[0])) continue;
    return fields[0].toLowerCase();
  }
  throw new Error(`SHA256SUMS does not contain a digest for ${binaryName}`);
}

/** Calculate a lowercase SHA-256 digest for binary content. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function resolveVersion(
  version: string,
  signal?: AbortSignal,
): Promise<string> {
  if (version !== "latest") return version;
  const res = await fetch(CODEBERG_API, { signal });
  if (!res.ok) {
    throw new Error(`Failed to fetch latest mere version: ${res.status}`);
  }
  const data: unknown = await res.json();
  if (
    typeof data !== "object" || data === null ||
    typeof (data as { tag_name?: unknown }).tag_name !== "string"
  ) {
    throw new Error("Latest Mere release response does not contain tag_name");
  }
  const tag = (data as { tag_name: string }).tag_name;
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

function getArch(): string {
  return Deno.build.arch;
}

async function publishedDigest(
  version: string,
  binaryName: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`${DOWNLOAD_BASE}/v${version}/SHA256SUMS`, {
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Mere SHA256SUMS for ${version}: ${response.status}`,
    );
  }
  return parseSHA256SUMS(await response.text(), binaryName);
}

async function ensureBinary(
  version: string,
  cacheDir: string,
  configuredDigest: string,
  signal?: AbortSignal,
): Promise<string> {
  const arch = getArch();
  const binaryName = `mere-${version}-linux-${arch}`;
  const binaryPath = `${cacheDir}/${binaryName}`;
  const expected = configuredDigest ||
    await publishedDigest(version, binaryName, signal);
  if (!/^[a-fA-F0-9]{64}$/.test(expected)) {
    throw new Error(
      "Configured mereSHA256 must be a 64-character hexadecimal SHA-256 digest",
    );
  }

  try {
    const cached = await Deno.readFile(binaryPath);
    if ((await sha256Hex(cached)) === expected.toLowerCase()) return binaryPath;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  await Deno.mkdir(cacheDir, { recursive: true });
  const url = `${DOWNLOAD_BASE}/v${version}/${binaryName}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(
      `Failed to download mere ${version} for ${arch}: ${res.status} from ${url}`,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actual = await sha256Hex(bytes);
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      `Mere binary checksum mismatch for ${binaryName}: got ${actual}, want ${expected}`,
    );
  }
  await Deno.writeFile(binaryPath, bytes, { mode: 0o755 });
  return binaryPath;
}

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

  try {
    const stat = await Deno.stat(storeDir);
    if (!stat.isDirectory) throw new Error(`${storeDir} is not a directory`);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    const output = await runCommand(mereBinary, {
      args: ["--root", mereRoot, "store", "init"],
      stdout: "piped",
      stderr: "piped",
    }, signal);
    if (!output.success) {
      throw new Error(
        `mere store init failed: ${new TextDecoder().decode(output.stderr)}`,
      );
    }
  }

  try {
    await Deno.stat(configPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    const res = await fetch(CONFIG_URL, { signal });
    if (!res.ok) throw new Error(`Failed to fetch Mere config: ${res.status}`);
    await Deno.writeTextFile(configPath, await res.text());
  }
  try {
    await Deno.stat(keyPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    await Deno.mkdir(keysDir, { recursive: true });
    const res = await fetch(KEY_URL, { signal });
    if (!res.ok) {
      throw new Error(`Failed to fetch Mere repository key: ${res.status}`);
    }
    await Deno.writeFile(keyPath, new Uint8Array(await res.arrayBuffer()));
  }
}

async function linkHostStore(mereRoot: string): Promise<void> {
  const hostStore = "/mere/store";
  const localStore = `${mereRoot}/mere/store`;
  try {
    const stat = await Deno.stat(hostStore);
    if (!stat.isDirectory) return;
  } catch {
    return;
  }
  try {
    const stat = await Deno.lstat(localStore);
    if (stat.isSymlink) return;
    await Deno.remove(localStore, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await Deno.symlink(hostStore, localStore);
}

async function writeProfileKdl(
  dir: string,
  packages: string[],
): Promise<string> {
  await Deno.mkdir(dir, { recursive: true });
  const profilePath = `${dir}/profile.kdl`;
  const packageLines = packages.map((pkg) => `  package "${pkg}"`).join("\n");
  await Deno.writeTextFile(profilePath, `profile {\n${packageLines}\n}\n`);
  return profilePath;
}

export function truncate(
  str: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(str);
  if (bytes.length <= maxBytes) return { text: str, truncated: false };
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(
      bytes.slice(0, maxBytes),
    ) + "\n... [truncated]",
    truncated: true,
  };
}

/** Swamp model definition for verified, cancellable Mere shell execution. */
export const model = {
  type: "@jeremy/mere-shell",
  version: "2026.08.19.1",
  description:
    "Execute typed argv inside a verified, cancellable Mere Linux shell namespace.",
  globalArguments: GlobalArgsSchema,
  upgrades: [{
    toVersion: "2026.08.17.1",
    description:
      "Replace lossy command strings with argv, verify downloaded binaries, and propagate model cancellation.",
    upgradeAttributes: (
      old: Record<string, unknown>,
    ): Record<string, unknown> => ({
      ...old,
      mereSHA256: old.mereSHA256 ?? "",
    }),
  }, {
    toVersion: "2026.08.19.1",
    description:
      "Fix download URL from Codeberg to GitHub where Mere releases are published.",
    upgradeAttributes: (
      old: Record<string, unknown>,
    ): Record<string, unknown> => old,
  }],
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
        "Run an exact argv inside a Mere shell with specified packages available.",
      arguments: z.object({
        packages: z.array(z.string()).describe(
          "Packages to make available in the shell.",
        ),
        argv: z.array(z.string()).min(1).describe(
          "Exact command argv; argv[0] is the executable.",
        ),
        workdir: z.string().optional().describe(
          "Working directory (bind-mounted into the namespace).",
        ),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: Record<string, unknown>, context: any) => {
        const { packages, argv, workdir } = args as {
          packages: string[];
          argv: string[];
          workdir?: string;
        };
        const globalArgs = context.globalArgs as {
          mereVersion: string;
          mereSHA256: string;
          mereRoot: string;
          useHostStore: boolean;
        };
        const start = performance.now();
        const repoDir = Deno.env.get("SWAMP_REPO_DIR") || Deno.cwd();
        const mereRoot = globalArgs.mereRoot ||
          `${repoDir}/.swamp/mere-shell/root`;
        try {
          const version = await resolveVersion(
            globalArgs.mereVersion,
            context.signal,
          );
          const mereBinary = await ensureBinary(
            version,
            `${repoDir}/.swamp/mere-shell/bin`,
            globalArgs.mereSHA256,
            context.signal,
          );
          await ensureRoot(mereRoot, mereBinary, context.signal);
          if (globalArgs.useHostStore) await linkHostStore(mereRoot);
          const profilePath = await writeProfileKdl(
            `${repoDir}/.swamp/mere-shell/profiles`,
            packages,
          );
          const shellArgs = [
            "--root",
            mereRoot,
            "shell",
            profilePath,
            "--",
            ...argv,
          ];
          context.logger.info("Executing Mere shell argv: {args}", {
            args: shellArgs.join(" "),
          });
          const output = await runCommand(mereBinary, {
            args: shellArgs,
            stdout: "piped",
            stderr: "piped",
            cwd: workdir,
          }, context.signal);
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
            stdout: stdout.text,
            stderr: stderr.text,
            truncated: stdout.truncated || stderr.truncated,
            durationMs: Math.round(performance.now() - start),
            mereVersion: version,
            mereRoot,
            packages,
            argv,
            success: output.success,
          };
          context.logger.info("Mere shell command completed", {
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            success: result.success,
          });
          return {
            dataHandles: [
              await context.writeResource("result", "current", result),
            ],
          };
        } catch (error) {
          const result = {
            exitCode: -1,
            stdout: "",
            stderr: "",
            truncated: false,
            durationMs: Math.round(performance.now() - start),
            mereVersion: globalArgs.mereVersion,
            mereRoot,
            packages,
            argv,
            success: false,
            error: String(error),
          };
          context.logger.error("Mere shell command failed", {
            error: result.error,
          });
          return {
            dataHandles: [
              await context.writeResource("result", "current", result),
            ],
          };
        }
      },
    },
  },
};
