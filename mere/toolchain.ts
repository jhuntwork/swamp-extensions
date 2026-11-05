import { z } from "npm:zod@4.1.12";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { runChecked } from "./models/_lib/runner.ts";
import {
  assertIsolatedRoot,
  DEFAULT_CONFIG_URL,
  DEFAULT_KEY_URL,
  ensureRoot,
  rootState,
} from "./models/_lib/root.ts";

const GlobalArgs = z.object({
  mereVersion: z.string().regex(
    /^\d+\.\d+\.\d+$/,
    "mereVersion must be an exact version such as 0.23.0, never 'latest'",
  ),
  mereRoot: z.string().default("").describe(
    "Isolated mere root. Empty derives .swamp/mere/<name>/root under the repo.",
  ),
  configUrl: z.string().url().default(DEFAULT_CONFIG_URL),
  publicKeyUrl: z.string().url().default(DEFAULT_KEY_URL),
});

const ProvisionArgs = z.object({
  archivePath: z.string().min(1).describe(
    "Path of the mere binary already downloaded and checksum-verified by a " +
      "@svendowideit/github-release-install download step.",
  ),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).describe(
    "Expected SHA-256 of the file at archivePath (from the release's SHA256SUMS).",
  ),
});

const ToolchainSchema = z.object({
  version: z.string(),
  binaryPath: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  root: z.string(),
  arch: z.string(),
  os: z.string(),
  storePresent: z.boolean(),
  configPresent: z.boolean(),
  keyPresent: z.boolean(),
  provisionedAt: z.string(),
  durationMs: z.number().nonnegative(),
});

export interface ToolchainPaths {
  base: string;
  binDir: string;
  binaryPath: string;
  root: string;
}

/** Every default derives from the repo directory; no host paths. */
export function resolvePaths(
  repoDir: string,
  name: string,
  globals: { mereVersion: string; mereRoot: string },
  arch: string = Deno.build.arch,
): ToolchainPaths {
  const base = join(repoDir, ".swamp", "mere", name);
  const root = globals.mereRoot || join(base, "root");
  assertIsolatedRoot(root);
  return {
    base,
    binDir: join(base, "bin"),
    binaryPath: join(base, "bin", `mere-${globals.mereVersion}-${arch}`),
    root,
  };
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await Deno.open(path, { read: true });
  for await (const chunk of file.readable) hash.update(chunk);
  return hash.digest("hex");
}

/** Copy a verified binary into place, executable, atomically. */
export async function installBinary(
  source: string,
  expectedSha256: string,
  destination: string,
): Promise<{ sha256: string; reused: boolean }> {
  const actual = await sha256File(source);
  if (actual !== expectedSha256) {
    throw new Error(
      `SHA-256 mismatch for ${source}: expected ${expectedSha256}, got ${actual}`,
    );
  }
  try {
    if (await sha256File(destination) === actual) {
      await Deno.chmod(destination, 0o755);
      return { sha256: actual, reused: true };
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await Deno.mkdir(join(destination, ".."), { recursive: true });
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await Deno.copyFile(source, temporary);
  await Deno.chmod(temporary, 0o755);
  await Deno.rename(temporary, destination);
  return { sha256: actual, reused: false };
}

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
};

async function assertVersion(
  binary: string,
  version: string,
  signal: AbortSignal,
) {
  const result = await runChecked(binary, ["--version"], {
    signal,
    timeoutMs: 30_000,
  });
  if (!result.stdout.includes(version)) {
    throw new Error(
      `${binary} reports "${result.stdout.trim()}", expected version ${version}`,
    );
  }
}

export const behavior = {
  type: "@jeremy/mere/toolchain",
  version: "2026.11.04.1",
  description:
    "A pinned, checksum-verified mere binary and an isolated store root.",
  globalArguments: GlobalArgs,
  resources: {
    toolchain: {
      description: "The provisioned mere binary and isolated root",
      schema: ToolchainSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    provision: {
      description:
        "Install an already-downloaded, checksum-verified mere binary and " +
        "initialise the isolated root (store, config, public key). Idempotent. " +
        "The download is a separate workflow step so this works on workers, " +
        "where runModel is unavailable.",
      kind: "action",
      arguments: ProvisionArgs,
      execute: async (
        args: z.infer<typeof ProvisionArgs>,
        context: Context,
      ) => {
        const started = performance.now();
        const globals = GlobalArgs.parse(context.globalArgs);
        const paths = resolvePaths(
          context.repoDir,
          context.definition.name,
          globals,
        );
        const installed = await installBinary(
          args.archivePath,
          args.sha256,
          paths.binaryPath,
        );
        await assertVersion(
          paths.binaryPath,
          globals.mereVersion,
          context.signal,
        );
        const state = await ensureRoot({
          binary: paths.binaryPath,
          root: paths.root,
          configUrl: globals.configUrl,
          publicKeyUrl: globals.publicKeyUrl,
          signal: context.signal,
        });
        const handle = await context.writeResource("toolchain", "toolchain", {
          version: globals.mereVersion,
          binaryPath: paths.binaryPath,
          sha256: installed.sha256,
          root: paths.root,
          arch: Deno.build.arch,
          os: Deno.build.os,
          ...state,
          provisionedAt: new Date().toISOString(),
          durationMs: performance.now() - started,
        });
        return { dataHandles: [handle] };
      },
    },
    status: {
      description:
        "Re-verify the installed binary's digest and report the root's state. " +
        "Throws when the binary is missing or has changed.",
      kind: "read",
      arguments: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
      execute: async (args: { sha256: string }, context: Context) => {
        const started = performance.now();
        const globals = GlobalArgs.parse(context.globalArgs);
        const paths = resolvePaths(
          context.repoDir,
          context.definition.name,
          globals,
        );
        const actual = await sha256File(paths.binaryPath);
        if (actual !== args.sha256) {
          throw new Error(
            `${paths.binaryPath} digest ${actual} does not match ${args.sha256}`,
          );
        }
        await assertVersion(
          paths.binaryPath,
          globals.mereVersion,
          context.signal,
        );
        const state = await rootState(paths.root);
        const handle = await context.writeResource("toolchain", "toolchain", {
          version: globals.mereVersion,
          binaryPath: paths.binaryPath,
          sha256: actual,
          root: paths.root,
          arch: Deno.build.arch,
          os: Deno.build.os,
          ...state,
          provisionedAt: new Date().toISOString(),
          durationMs: performance.now() - started,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
