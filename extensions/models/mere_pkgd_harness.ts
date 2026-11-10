import { z } from "npm:zod@4.4.3";

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const SCRATCH_MARKER = "swamp-mere-pkgd-harness-v1\n";
const ARCHIVE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9+._-]*\.pkg\.tar\.zst$/;
const AbsolutePathSchema = z.string().min(1).refine(
  (value) => value.startsWith("/"),
  "must be an absolute path",
);
const UrlSchema = z.string().url().max(2048).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "must use http or https");
const PackageNameSchema = z.string().min(1).max(256).regex(
  /^[A-Za-z0-9][A-Za-z0-9+._-]*$/,
  "must be a package name, not a path",
);

function scratchPath(scratchDir: string, name: string): string {
  return `${scratchDir.replace(/\/+$/, "")}/${name}`;
}

function assertSafeScratchDir(scratchDir: string): string {
  AbsolutePathSchema.parse(scratchDir);
  const normalized = scratchDir.replace(/\/+$/, "") || "/";
  if (
    normalized === "/" ||
    normalized === "/tmp" ||
    normalized === "/var" ||
    normalized === "/var/tmp" ||
    normalized === "/home" ||
    normalized === "/root"
  ) {
    throw new Error(
      "scratchDir must be a dedicated child directory, not a shared filesystem root",
    );
  }
  if (normalized.split("/").includes("..")) {
    throw new Error("scratchDir must not contain '..' path components");
  }
  return normalized;
}

async function prepareScratchDir(scratchDir: string): Promise<string> {
  const normalized = assertSafeScratchDir(scratchDir);
  await Deno.mkdir(normalized, { recursive: true });
  const markerPath = scratchPath(normalized, ".swamp-owner");
  try {
    const marker = await Deno.readTextFile(markerPath);
    if (marker !== SCRATCH_MARKER) {
      throw new Error(
        `Refusing scratch directory without the expected ownership marker: ${normalized}`,
      );
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    await Deno.writeTextFile(markerPath, SCRATCH_MARKER, { mode: 0o600 });
  }
  return normalized;
}

function validateArchiveName(name: string): void {
  if (
    !ARCHIVE_NAME_PATTERN.test(name) ||
    name.includes("..") ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new Error(`Invalid package archive name: ${name}`);
  }
}

function validateWorkspace(workspace: string): void {
  AbsolutePathSchema.parse(workspace);
  if (workspace.split("/").includes("..")) {
    throw new Error(`Invalid build workspace: ${workspace}`);
  }
}

async function terminateOwnedProcess(
  instance: { pid: number; pkgdBinPath: string },
): Promise<boolean> {
  try {
    const [actualPath, expectedPath] = await Promise.all([
      Deno.realPath(`/proc/${instance.pid}/exe`),
      Deno.realPath(instance.pkgdBinPath),
    ]);
    if (actualPath !== expectedPath) return false;
    Deno.kill(instance.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function displayArgs(args: string[]): string {
  return args.map((arg) =>
    /^Authorization: Bearer\s+/i.test(arg)
      ? "Authorization: Bearer <redacted>"
      : arg
  ).join(" ");
}

const GlobalArgsSchema = z.object({
  mereRepoPath: z.string().min(1).describe(
    "Absolute local git checkout of codeberg.org/merelinux/mere to build from",
  ),
  pkgdRepoPath: z.string().min(1).describe(
    "Absolute local git checkout of codeberg.org/merelinux/pkgd to build from",
  ),
  scratchDir: z.string().min(1).describe(
    "Dedicated absolute scratch directory for this harness run — everything lives under here, nothing touches the real /mere",
  ),
});

const BuildSchema = z.object({
  mereBinPath: z.string(),
  pkgdBinPath: z.string(),
});

const InstanceSchema = z.object({
  pid: z.number(),
  socketPath: z.string(),
  scratchDir: z.string().optional(),
  mereRoot: z.string(),
  devRepoName: z.string(),
  outputDir: z.string(),
  keyDir: z.string(),
  publishToken: z.string().meta({ sensitive: true }),
  mereBinPath: z.string(),
  pkgdBinPath: z.string().optional(),
});

const PublishResultSchema = z.object({
  packageName: z.string(),
  recipePath: z.string(),
  archivePaths: z.array(z.string()),
  responseBody: z.string(),
});

const VerifyResultSchema = z.object({
  packageName: z.string(),
  foundInRepoDb: z.boolean(),
  version: z.string().nullable(),
});

const VerifyPropertiesResultSchema = z.object({
  packageName: z.string(),
  hasProperties: z.boolean(),
  description: z.string().nullable(),
  url: z.string().nullable(),
  licenses: z.array(z.string()).nullable(),
  sourceUrls: z.array(z.string()).nullable(),
});

const HashSourceResultSchema = z.object({
  url: z.string(),
  blake3: z.string(),
  filename: z.string(),
});

function sourceFilename(url: string): string {
  const pathname = new URL(url).pathname;
  const basename = pathname.split("/").pop() ?? "";
  return basename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "source";
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Result of running a command: exit code plus bounded captured stdout/stderr. */
export type RunResult = { code: number; stdout: string; stderr: string };

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = maxBytes - length;
    if (remaining > 0) {
      const kept = value.subarray(0, Math.min(remaining, value.length));
      chunks.push(kept);
      length += kept.length;
    }
    if (value.length > remaining) truncated = true;
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const text = new TextDecoder().decode(bytes);
  return { text: truncated ? `${text}\n... [truncated]` : text, truncated };
}

/** Runs a command and captures its outcome without throwing on a non-zero exit. */
export async function run(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): Promise<RunResult> {
  // swamp-quality-ignore deno-command: fixed argv boundary for local build and verification tools
  const command = new Deno.Command(cmd, {
    args,
    cwd: opts?.cwd,
    env: opts?.env,
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const [stdout, stderr] = await Promise.all([
    readBounded(child.stdout!, MAX_COMMAND_OUTPUT_BYTES),
    readBounded(child.stderr!, MAX_COMMAND_OUTPUT_BYTES),
  ]);
  const status = await child.status;
  return {
    code: status.code,
    stdout: stdout.text,
    stderr: stderr.text,
  };
}

/** Like {@linkcode run}, but throws with the captured output on a non-zero exit. */
export async function mustRun(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): Promise<string> {
  const result = await run(cmd, args, opts);
  if (result.code !== 0) {
    throw new Error(
      `${cmd} ${displayArgs(args)} failed (exit ${result.code}): ${
        result.stderr || result.stdout
      }`,
    );
  }
  return result.stdout;
}

/**
 * Escapes a string for safe interpolation inside a single-quoted SQLite
 * string literal, per the SQL standard (double any embedded `'`).
 */
export function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Extracts the build workspace and produced archive filenames from `mere dev
 * build`'s stdout. `mere dev build` prints one `output: <archive>.pkg.tar.zst`
 * line per produced package, and a `workspace: <dir>` line giving the build
 * workspace containing `pkg/<archive>`.
 */
export function parseBuildOutput(
  buildOutput: string,
): { workspace: string; archiveNames: string[] } {
  const workspaceMatch = buildOutput.match(/workspace: (\S+)/);
  if (!workspaceMatch) {
    throw new Error(
      `Could not find workspace in mere dev build output:\n${buildOutput}`,
    );
  }
  const workspace = workspaceMatch[1];
  validateWorkspace(workspace);
  const archiveNames = [
    ...buildOutput.matchAll(/output: (\S+\.pkg\.tar\.zst)/g),
  ].map((m) => m[1]);
  if (archiveNames.length === 0) {
    throw new Error(
      `Could not find any output archives in mere dev build output:\n${buildOutput}`,
    );
  }
  for (const archiveName of archiveNames) validateArchiveName(archiveName);
  return { workspace, archiveNames };
}

/** Derives the bare package name from a canonical archive filename, e.g. `jq-1.8.1-4-x86_64-<hash>.pkg.tar.zst` -> `jq`. */
export function packageNameFromArchive(archiveName: string): string {
  validateArchiveName(archiveName);
  const match = archiveName.match(
    /^(.+)-\d[^-]*-\d+-[^-]+-[A-Za-z0-9]+\.pkg\.tar\.zst$/,
  );
  if (!match) {
    throw new Error(
      `Archive does not use the canonical package filename: ${archiveName}`,
    );
  }
  return PackageNameSchema.parse(match[1]);
}

type Logger = {
  info: (msg: string, props?: Record<string, unknown>) => void;
};

/** Wait for a process-owned path to appear, failing instead of returning a false success. */
export async function waitForPath(
  path: string,
  options: {
    attempts?: number;
    delayMs?: number;
    stat?: (path: string) => Promise<unknown>;
  } = {},
): Promise<void> {
  const attempts = options.attempts ?? 20;
  const delayMs = options.delayMs ?? 100;
  const stat = options.stat ?? ((value: string) => Deno.stat(value));

  for (let i = 0; i < attempts; i++) {
    try {
      await stat(path);
      return;
    } catch {
      if (i + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw new Error(
    `Timed out waiting for pkgd to create its socket at ${path}`,
  );
}

/**
 * A local integration-test harness for the mere <-> pkgd package-publish
 * pipeline (see https://codeberg.org/merelinux).
 *
 * Builds both binaries from local branch checkouts, runs `pkgd` as a real
 * background process against scratch directories, publishes a real signed
 * test package to it over its actual HTTP `/publish` endpoint, and verifies
 * the result — all without ever touching the real `/mere/store` or
 * `/mere/dev/repo` on the host machine.
 *
 * Methods (run in order): `build` → `start` → `publish_test_package` →
 * `verify_published` → `stop`. Chain them into a workflow to make the whole
 * dry run a single `swamp workflow run` — see the README for an example.
 *
 * Known limitation: if the `start` method is interrupted between spawning
 * `pkgd` and recording the `instance` resource, the spawned process is
 * orphaned (no recorded PID for `stop` to find). Acceptable for a local,
 * interactively-run dev harness; not suited to unattended environments where
 * that gap matters more.
 */
export const model = {
  type: "@jeremy/mere-pkgd-harness",
  version: "2026.11.10.1",
  upgrades: [{
    toVersion: "2026.11.10.1",
    description:
      "Bound subprocess output and downloads, protect scratch cleanup, validate package paths, and redact publish credentials from command errors.",
    upgradeAttributes: (
      old: Record<string, unknown>,
    ): Record<string, unknown> => old,
  }],
  globalArguments: GlobalArgsSchema,
  resources: {
    "build": {
      description: "Built mere and pkgd binary paths",
      schema: BuildSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "instance": {
      description: "A running pkgd test instance",
      schema: InstanceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "publish-result": {
      description: "Result of publishing one test package through pkgd",
      schema: PublishResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "verify-result": {
      description:
        "Result of verifying a package landed in the published repo.db",
      schema: VerifyResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "verify-properties-result": {
      description:
        "Result of verifying a package's properties (metadata) in repo.db",
      schema: VerifyPropertiesResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "hash-source-result": {
      description:
        "Result of downloading a source URL and computing its blake3 hash",
      schema: HashSourceResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    hash_source: {
      description:
        "Download a source URL to a temp file and compute its blake3 hash via the mere binary",
      arguments: z.object({
        url: UrlSchema.describe("HTTP or HTTPS URL to download and hash"),
      }),
      execute: async (
        args: { url: string; _mustRun?: typeof mustRun },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          logger: Logger;
          readResource: (
            name: string,
          ) => Promise<Record<string, unknown> | null>;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const doRun = args._mustRun ?? mustRun;
        const { mereRepoPath, scratchDir } = context.globalArgs;
        const url = UrlSchema.parse(args.url);
        const safeScratchDir = await prepareScratchDir(scratchDir);

        // Use pre-built mere if available, otherwise build path.
        const build = await context.readResource("build") as
          | z.infer<typeof BuildSchema>
          | null;
        const mereBin = build?.mereBinPath ??
          `${mereRepoPath}/zig-out/bin/mere`;

        // Derive a bounded, path-safe filename from the URL basename.
        const filename = sourceFilename(url);
        const downloadDir = scratchPath(safeScratchDir, "hash-downloads");
        await Deno.mkdir(downloadDir, { recursive: true });
        const destPath = `${downloadDir}/${filename}`;

        context.logger.info("Downloading {url}", { url });
        await doRun("curl", [
          "--fail",
          "--location",
          "--silent",
          "--show-error",
          "--proto",
          "=http,https",
          "--max-filesize",
          String(MAX_SOURCE_BYTES),
          "--output",
          destPath,
          url,
        ]);

        context.logger.info("Computing blake3 hash for {filename}", {
          filename,
        });
        const hashOutput = await doRun(mereBin, ["dev", "hash", destPath]);
        const blake3 = hashOutput.trim();

        const handle = await context.writeResource(
          "hash-source-result",
          `hash-${await sha256Hex(url)}`,
          { url, blake3, filename },
        );
        context.logger.info("Hash computed", { url, blake3 });
        return { dataHandles: [handle] };
      },
    },

    build: {
      description:
        "Compile mere (zig build) and pkgd (go build) from their local checkouts",
      arguments: z.object({}),
      execute: async (
        args: Record<string, never> & { _mustRun?: typeof mustRun },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          logger: Logger;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const { mereRepoPath, pkgdRepoPath, scratchDir } = context.globalArgs;
        AbsolutePathSchema.parse(mereRepoPath);
        AbsolutePathSchema.parse(pkgdRepoPath);
        const safeScratchDir = await prepareScratchDir(scratchDir);
        const doRun = args._mustRun ?? mustRun;

        context.logger.info("Building mere from {path}", {
          path: mereRepoPath,
        });
        await doRun("zig", ["build"], { cwd: mereRepoPath });
        const mereBinPath = `${mereRepoPath}/zig-out/bin/mere`;

        context.logger.info("Building pkgd from {path}", {
          path: pkgdRepoPath,
        });
        const pkgdBinPath = scratchPath(safeScratchDir, "bin/pkgd");
        await Deno.mkdir(scratchPath(safeScratchDir, "bin"), {
          recursive: true,
        });
        await doRun("go", ["build", "-o", pkgdBinPath, "./cmd/pkgd"], {
          cwd: pkgdRepoPath,
        });

        const handle = await context.writeResource("build", "build", {
          mereBinPath,
          pkgdBinPath,
        });
        context.logger.info("Build complete", { mereBinPath, pkgdBinPath });
        return { dataHandles: [handle] };
      },
    },

    start: {
      description:
        "Generate a throwaway signing key and start pkgd as a background process against fresh scratch directories",
      arguments: z.object({}),
      execute: async (
        args: Record<string, never> & { _mustRun?: typeof mustRun },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          logger: Logger;
          readResource: (
            name: string,
          ) => Promise<Record<string, unknown> | null>;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const { scratchDir } = context.globalArgs;
        const safeScratchDir = await prepareScratchDir(scratchDir);
        const doRun = args._mustRun ?? mustRun;
        const build = await context.readResource("build") as
          | z.infer<typeof BuildSchema>
          | null;
        if (!build) {
          throw new Error("No build found — run the build method first");
        }

        const previous = await context.readResource("instance") as
          | { pid: number; pkgdBinPath?: string }
          | null;
        if (previous?.pkgdBinPath) {
          await terminateOwnedProcess({
            pid: previous.pid,
            pkgdBinPath: previous.pkgdBinPath,
          });
        }

        const keyDir = scratchPath(safeScratchDir, "keys");
        const mereRoot = scratchPath(safeScratchDir, "mere-root");
        const outputDir = scratchPath(safeScratchDir, "output");
        const tempDir = scratchPath(safeScratchDir, "tmp");
        const socketPath = scratchPath(safeScratchDir, "pkgd.sock");
        const devRepoName = "harness";
        const publishToken = crypto.randomUUID();

        // start is idempotent: don't assume a previous run's stop cleaned up
        // (it may not have run at all, e.g. after a killed/failed workflow).
        // Clear just the directories this method owns — not scratchDir
        // itself, which also holds the pkgd binary the build step just
        // placed there.
        context.logger.info("Resetting scratch directories under {dir}", {
          dir: safeScratchDir,
        });
        for (
          const dir of [
            keyDir,
            mereRoot,
            outputDir,
            tempDir,
            scratchPath(safeScratchDir, "hash-downloads"),
          ]
        ) {
          await Deno.remove(dir, { recursive: true }).catch(() => {});
        }
        await Deno.remove(socketPath).catch(() => {});

        await Deno.mkdir(keyDir, { recursive: true });
        await Deno.mkdir(outputDir, { recursive: true });
        await Deno.mkdir(tempDir, { recursive: true });
        // Deliberately NOT creating mereRoot's dev-repo leaf directory here —
        // `mere dev import` (invoked by pkgd) only auto-bootstraps a dev repo
        // addressed by --root + name when it doesn't exist yet; a
        // pre-existing empty directory is treated as an invalid repo.

        context.logger.info("Generating throwaway signing key");
        await doRun(build.mereBinPath, [
          "dev",
          "key",
          "generate",
          "-o",
          keyDir,
        ]);

        context.logger.info("Starting pkgd", { bin: build.pkgdBinPath });
        // swamp-quality-ignore deno-command: pkgd is the process under test
        const command = new Deno.Command(build.pkgdBinPath, {
          env: {
            PKGD_MERE_ROOT: mereRoot,
            PKGD_DEV_REPO_NAME: devRepoName,
            PKGD_OUTPUT_DIR: outputDir,
            PKGD_MERE_BIN: build.mereBinPath,
            PKGD_SIGNING_KEY_PATH: `${keyDir}/mere.key`,
            PKGD_PUBLISH_TOKEN: publishToken,
            PKGD_LISTEN_SOCKET: socketPath,
            PKGD_TEMP_DIR: tempDir,
          },
          stdout: "null",
          stderr: "null",
        });
        const child = command.spawn();
        child.unref();

        // Do not record an instance until pkgd is reachable. If startup fails,
        // terminate the child so a failed attempt cannot leave an orphan.
        try {
          await waitForPath(socketPath);
        } catch (error) {
          try {
            Deno.kill(child.pid, "SIGTERM");
          } catch {
            // The child may already have exited.
          }
          throw error;
        }

        const handle = await context.writeResource("instance", "instance", {
          pid: child.pid,
          socketPath,
          scratchDir: safeScratchDir,
          mereRoot,
          devRepoName,
          outputDir,
          keyDir,
          publishToken,
          mereBinPath: build.mereBinPath,
          pkgdBinPath: build.pkgdBinPath,
        });
        context.logger.info("pkgd started", {
          pid: child.pid,
          socketPath,
        });
        return { dataHandles: [handle] };
      },
    },

    publish_test_package: {
      description:
        "Build a real signed test package via `mere dev build` and POST it to the running pkgd instance's /publish",
      arguments: z.object({
        recipePath: AbsolutePathSchema.describe(
          "Absolute path to a recipe.kdl to build",
        ),
      }),
      execute: async (
        args: { recipePath: string; _mustRun?: typeof mustRun },
        context: {
          logger: Logger;
          readResource: (
            name: string,
          ) => Promise<Record<string, unknown> | null>;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const doRun = args._mustRun ?? mustRun;
        const recipePath = AbsolutePathSchema.parse(args.recipePath);
        const instance = await context.readResource("instance") as
          | z.infer<typeof InstanceSchema>
          | null;
        if (!instance) {
          throw new Error(
            "No running instance found — run the start method first",
          );
        }

        context.logger.info("Building test package from {recipe}", {
          recipe: recipePath,
        });
        const buildOutput = await doRun(instance.mereBinPath, [
          "dev",
          "build",
          recipePath,
        ]);
        const { workspace, archiveNames } = parseBuildOutput(buildOutput);
        const archivePaths = archiveNames.map((name) =>
          `${workspace}/pkg/${name}`
        );

        const scratchDir = assertSafeScratchDir(
          instance.scratchDir ??
            instance.socketPath.replace(/\/pkgd\.sock$/, ""),
        );
        const authConfigPath = scratchPath(
          scratchDir,
          `.curl-${crypto.randomUUID()}.conf`,
        );
        const tokenForConfig = instance.publishToken.replace(/[\\"\r\n]/g, "");
        await Deno.writeTextFile(
          authConfigPath,
          `header = "Authorization: Bearer ${tokenForConfig}"\n`,
          { mode: 0o600 },
        );

        const curlArgs = [
          "--fail",
          "--silent",
          "--show-error",
          "--unix-socket",
          instance.socketPath,
          "--config",
          authConfigPath,
        ];
        for (const path of archivePaths) {
          curlArgs.push("-F", `package=@${path}`);
        }
        curlArgs.push("http://localhost/publish");

        context.logger.info("Publishing {count} archive(s) to pkgd", {
          count: archivePaths.length,
        });
        let responseBody: string;
        try {
          responseBody = await doRun("curl", curlArgs);
        } finally {
          await Deno.remove(authConfigPath).catch(() => {});
        }
        let parsed: { success?: boolean };
        try {
          parsed = JSON.parse(responseBody);
        } catch {
          throw new Error(
            `pkgd /publish returned non-JSON response: ${responseBody}`,
          );
        }
        if (parsed.success !== true) {
          throw new Error(`pkgd /publish reported failure: ${responseBody}`);
        }

        const packageName = packageNameFromArchive(archiveNames[0]);
        const handle = await context.writeResource(
          "publish-result",
          `publish-${packageName}`,
          {
            packageName,
            recipePath,
            archivePaths,
            responseBody,
          },
        );
        context.logger.info("Published {packageName}", { packageName });
        return { dataHandles: [handle] };
      },
    },

    verify_published: {
      description:
        "Confirm a package landed in the published repo.db (queried directly, sidestepping any HTTP-layer caching)",
      arguments: z.object({
        packageName: PackageNameSchema,
      }),
      execute: async (
        args: { packageName: string; _run?: typeof run },
        context: {
          logger: Logger;
          readResource: (
            name: string,
          ) => Promise<Record<string, unknown> | null>;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const doRun = args._run ?? run;
        const instance = await context.readResource("instance") as
          | z.infer<typeof InstanceSchema>
          | null;
        if (!instance) {
          throw new Error(
            "No running instance found — run the start method first",
          );
        }

        const packageName = PackageNameSchema.parse(args.packageName);
        context.logger.info("Verifying {packageName} in published repo.db", {
          packageName,
        });
        const repoDbPath = `${instance.outputDir}/repo.db`;
        const result = await doRun("sqlite3", [
          repoDbPath,
          `select version from packages where name = '${
            escapeSqlString(packageName)
          }';`,
        ]);
        // A non-zero exit is a real tool/query failure (missing db, bad
        // sqlite3 install, corrupt file) — distinct from a legitimate "not
        // found", which is exit 0 with empty stdout. Conflating the two
        // would silently mask real failures as "package not published".
        if (result.code !== 0) {
          throw new Error(
            `sqlite3 query against ${repoDbPath} failed (exit ${result.code}): ${
              result.stderr || result.stdout
            }`,
          );
        }
        const version = result.stdout.trim();

        const handle = await context.writeResource(
          "verify-result",
          `verify-${packageName}`,
          {
            packageName,
            foundInRepoDb: version !== "",
            version: version !== "" ? version : null,
          },
        );
        context.logger.info("Verification complete", {
          packageName,
          foundInRepoDb: version !== "",
        });
        return { dataHandles: [handle] };
      },
    },

    verify_properties: {
      description:
        "Verify that a package's properties column in repo.db contains the expected recipe metadata (description, url, licenses, source_urls)",
      arguments: z.object({
        packageName: PackageNameSchema,
      }),
      execute: async (
        args: { packageName: string; _run?: typeof run },
        context: {
          logger: Logger;
          readResource: (
            name: string,
          ) => Promise<Record<string, unknown> | null>;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const doRun = args._run ?? run;
        const instance = await context.readResource("instance") as
          | z.infer<typeof InstanceSchema>
          | null;
        if (!instance) {
          throw new Error(
            "No running instance found — run the start method first",
          );
        }

        const packageName = PackageNameSchema.parse(args.packageName);
        context.logger.info(
          "Verifying properties for {packageName} in published repo.db",
          { packageName },
        );
        const repoDbPath = `${instance.outputDir}/repo.db`;
        const result = await doRun("sqlite3", [
          repoDbPath,
          `select properties from packages where name = '${
            escapeSqlString(packageName)
          }' order by release desc limit 1;`,
        ]);
        if (result.code !== 0) {
          throw new Error(
            `sqlite3 query against ${repoDbPath} failed (exit ${result.code}): ${
              result.stderr || result.stdout
            }`,
          );
        }
        const raw = result.stdout.trim();
        let description: string | null = null;
        let url: string | null = null;
        let licenses: string[] | null = null;
        let sourceUrls: string[] | null = null;
        let hasProperties = false;

        if (raw !== "") {
          try {
            const parsed: unknown = JSON.parse(raw);
            if (typeof parsed !== "object" || parsed === null) {
              throw new Error("properties is not an object");
            }
            const properties = parsed as Record<string, unknown>;
            hasProperties = true;
            description = typeof properties.description === "string"
              ? properties.description
              : null;
            url = typeof properties.url === "string" ? properties.url : null;
            licenses = Array.isArray(properties.licenses) &&
                properties.licenses.every((value) => typeof value === "string")
              ? properties.licenses as string[]
              : null;
            sourceUrls = Array.isArray(properties.source_urls) &&
                properties.source_urls.every((value) =>
                  typeof value === "string"
                )
              ? properties.source_urls as string[]
              : null;
          } catch {
            context.logger.info(
              "Properties column is not valid JSON: {raw}",
              { raw },
            );
          }
        }

        const handle = await context.writeResource(
          "verify-properties-result",
          `verify-props-${packageName}`,
          {
            packageName,
            hasProperties,
            description,
            url,
            licenses,
            sourceUrls,
          },
        );
        context.logger.info("Properties verification complete", {
          packageName,
          hasProperties,
          description: description ?? "(none)",
          url: url ?? "(none)",
        });
        return { dataHandles: [handle] };
      },
    },

    stop: {
      description:
        "Stop the running pkgd instance and remove only this harness's owned scratch entries",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          logger: Logger;
          readResource: (
            name: string,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const safeScratchDir = await prepareScratchDir(
          context.globalArgs.scratchDir,
        );
        const instance = await context.readResource("instance") as
          | z.infer<typeof InstanceSchema>
          | null;
        if (instance?.pkgdBinPath) {
          context.logger.info("Stopping pkgd", { pid: instance.pid });
          const stopped = await terminateOwnedProcess({
            pid: instance.pid,
            pkgdBinPath: instance.pkgdBinPath,
          });
          if (!stopped) {
            context.logger.info("Did not stop an unverified process", {
              pid: instance.pid,
            });
          }
        }
        for (
          const path of [
            "keys",
            "mere-root",
            "output",
            "tmp",
            "hash-downloads",
            "pkgd.sock",
            "bin/pkgd",
          ]
        ) {
          await Deno.remove(scratchPath(safeScratchDir, path), {
            recursive: true,
          }).catch(() => {});
        }
        context.logger.info("Owned scratch entries removed", {
          scratchDir: safeScratchDir,
        });
        return { dataHandles: [] };
      },
    },
  },
};
