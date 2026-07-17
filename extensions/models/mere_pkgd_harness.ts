import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  mereRepoPath: z.string().describe(
    "Local git checkout of codeberg.org/merelinux/mere to build from",
  ),
  pkgdRepoPath: z.string().describe(
    "Local git checkout of codeberg.org/merelinux/pkgd to build from",
  ),
  scratchDir: z.string().describe(
    "Root scratch directory for this harness run — everything lives under here, nothing touches the real /mere",
  ),
});

const BuildSchema = z.object({
  mereBinPath: z.string(),
  pkgdBinPath: z.string(),
});

const InstanceSchema = z.object({
  pid: z.number(),
  socketPath: z.string(),
  mereRoot: z.string(),
  devRepoName: z.string(),
  outputDir: z.string(),
  keyDir: z.string(),
  publishToken: z.string().meta({ sensitive: true }),
  mereBinPath: z.string(),
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

/** Result of running a command: exit code plus captured stdout/stderr. */
export type RunResult = { code: number; stdout: string; stderr: string };

/** Runs a command and captures its outcome without throwing on a non-zero exit. */
export async function run(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): Promise<RunResult> {
  const command = new Deno.Command(cmd, {
    args,
    cwd: opts?.cwd,
    env: opts?.env,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
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
      `${cmd} ${args.join(" ")} failed (exit ${result.code}): ${
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
  const archiveNames = [
    ...buildOutput.matchAll(/output: (\S+\.pkg\.tar\.zst)/g),
  ].map((m) => m[1]);
  if (archiveNames.length === 0) {
    throw new Error(
      `Could not find any output archives in mere dev build output:\n${buildOutput}`,
    );
  }
  return { workspace: workspaceMatch[1], archiveNames };
}

/** Derives the bare package name from a canonical archive filename, e.g. `jq-1.8.1-4-x86_64-<hash>.pkg.tar.zst` -> `jq`. */
export function packageNameFromArchive(archiveName: string): string {
  return archiveName.split(/-\d/)[0];
}

type Logger = {
  info: (msg: string, props?: Record<string, unknown>) => void;
};

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
  version: "2026.07.17.1",
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
  },
  methods: {
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
        const doRun = args._mustRun ?? mustRun;

        context.logger.info("Building mere from {path}", {
          path: mereRepoPath,
        });
        await doRun("zig", ["build"], { cwd: mereRepoPath });
        const mereBinPath = `${mereRepoPath}/zig-out/bin/mere`;

        context.logger.info("Building pkgd from {path}", {
          path: pkgdRepoPath,
        });
        const pkgdBinPath = `${scratchDir}/pkgd`;
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
        _args: Record<string, never>,
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
        const build = await context.readResource("build") as
          | z.infer<typeof BuildSchema>
          | null;
        if (!build) {
          throw new Error("No build found — run the build method first");
        }

        const keyDir = `${scratchDir}/keys`;
        const mereRoot = `${scratchDir}/mere-root`;
        const outputDir = `${scratchDir}/output`;
        const tempDir = `${scratchDir}/tmp`;
        const socketPath = `${scratchDir}/pkgd.sock`;
        const devRepoName = "harness";
        const publishToken = crypto.randomUUID();

        // start is idempotent: don't assume a previous run's stop cleaned up
        // (it may not have run at all, e.g. after a killed/failed workflow).
        // Clear just the directories this method owns — not scratchDir
        // itself, which also holds the pkgd binary the build step just
        // placed there.
        context.logger.info("Resetting scratch directories under {dir}", {
          dir: scratchDir,
        });
        for (const dir of [keyDir, mereRoot, outputDir, tempDir]) {
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
        await mustRun(build.mereBinPath, [
          "dev",
          "key",
          "generate",
          "-o",
          keyDir,
        ]);

        context.logger.info("Starting pkgd", { bin: build.pkgdBinPath });
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

        // Give it a moment to create the socket before anything tries to use it.
        for (let i = 0; i < 20; i++) {
          try {
            await Deno.stat(socketPath);
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 100));
          }
        }

        const handle = await context.writeResource("instance", "instance", {
          pid: child.pid,
          socketPath,
          mereRoot,
          devRepoName,
          outputDir,
          keyDir,
          publishToken,
          mereBinPath: build.mereBinPath,
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
        recipePath: z.string().describe(
          "Path to a recipe.kdl to build, e.g. a small recipe from the recipes checkout",
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
        const instance = await context.readResource("instance") as
          | z.infer<typeof InstanceSchema>
          | null;
        if (!instance) {
          throw new Error(
            "No running instance found — run the start method first",
          );
        }

        context.logger.info("Building test package from {recipe}", {
          recipe: args.recipePath,
        });
        const buildOutput = await doRun(instance.mereBinPath, [
          "dev",
          "build",
          args.recipePath,
        ]);
        const { workspace, archiveNames } = parseBuildOutput(buildOutput);
        const archivePaths = archiveNames.map((name) =>
          `${workspace}/pkg/${name}`
        );

        const curlArgs = [
          "-sS",
          "--unix-socket",
          instance.socketPath,
          "-H",
          `Authorization: Bearer ${instance.publishToken}`,
        ];
        for (const path of archivePaths) {
          curlArgs.push("-F", `package=@${path}`);
        }
        curlArgs.push("http://localhost/publish");

        context.logger.info("Publishing {count} archive(s) to pkgd", {
          count: archivePaths.length,
        });
        const responseBody = await doRun("curl", curlArgs);
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
            recipePath: args.recipePath,
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
        packageName: z.string(),
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

        context.logger.info("Verifying {packageName} in published repo.db", {
          packageName: args.packageName,
        });
        const repoDbPath = `${instance.outputDir}/repo.db`;
        const result = await doRun("sqlite3", [
          repoDbPath,
          `select version from packages where name = '${
            escapeSqlString(args.packageName)
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
          `verify-${args.packageName}`,
          {
            packageName: args.packageName,
            foundInRepoDb: version !== "",
            version: version !== "" ? version : null,
          },
        );
        context.logger.info("Verification complete", {
          packageName: args.packageName,
          foundInRepoDb: version !== "",
        });
        return { dataHandles: [handle] };
      },
    },

    stop: {
      description:
        "Kill the running pkgd instance and remove all scratch directories",
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
        const instance = await context.readResource("instance") as
          | z.infer<typeof InstanceSchema>
          | null;
        if (instance) {
          context.logger.info("Stopping pkgd", { pid: instance.pid });
          try {
            Deno.kill(instance.pid, "SIGTERM");
          } catch {
            // Already gone — fine.
          }
        }
        await Deno.remove(context.globalArgs.scratchDir, { recursive: true })
          .catch(() => {});
        context.logger.info("Scratch directories removed", {
          scratchDir: context.globalArgs.scratchDir,
        });
        return { dataHandles: [] };
      },
    },
  },
};
