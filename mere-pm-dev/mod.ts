// ABOUTME: Bounded Swamp model for building and validating the Mere package-manager source tree.
// ABOUTME: Executes fixed Zig argv only; it has no release acquisition, package-root, recipe, or publishing authority.
// deno-lint-ignore-file no-import-prefix
import { z } from "npm:zod@4";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MERE_BINARY_RELATIVE_PATH = "zig-out/bin/mere";

type Method = "build" | "test" | "releaseBuild" | "smoke";
type ResourceName =
  | "build-result"
  | "test-result"
  | "baseline-build-result"
  | "smoke-result";

type ModelContext = {
  signal?: AbortSignal;
  writeResource: (
    name: ResourceName,
    key: string,
    attributes: Record<string, unknown>,
  ) => Promise<unknown>;
};

const SourcePathArgsSchema = z.object({
  sourcePath: z.string().min(1).describe(
    "Absolute path to the Mere package-manager source checkout or isolated worktree.",
  ),
});

const CommandResultSchema = z.object({
  argv: z.array(z.string()),
  sourcePath: z.string(),
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  durationMs: z.number(),
  success: z.boolean(),
  error: z.string().optional(),
});

const BuildResultSchema = CommandResultSchema.extend({
  binaryPath: z.string(),
});
const BaselineBuildResultSchema = BuildResultSchema.extend({
  baseline: z.literal(true),
});

/** Truncate UTF-8 output while reporting whether the capture was capped. */
export function truncate(
  text: string,
  maxBytes = MAX_OUTPUT_BYTES,
): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(
      bytes.slice(0, maxBytes),
    ) + "\n... [truncated]",
    truncated: true,
  };
}

/** Return the exact fixed argv associated with one bounded validation method. */
export function fixedArgv(method: Method): string[] {
  switch (method) {
    case "build":
      return ["zig", "build"];
    case "test":
      return ["zig", "build", "test", "--summary", "all"];
    case "releaseBuild":
      return ["zig", "build", "-Doptimize=ReleaseSmall", "-Dcpu=baseline"];
    case "smoke":
      return [`./${MERE_BINARY_RELATIVE_PATH}`, "describe"];
  }
}

/** Execute an exact argv in a supplied source directory with cancellation support. */
export async function runCommand(
  argv: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<Deno.CommandOutput> {
  return await new Deno.Command(argv[0], {
    args: argv.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
    signal,
  }).output();
}

async function requireSourceTree(sourcePath: string): Promise<void> {
  const stat = await Deno.stat(sourcePath);
  if (!stat.isDirectory) {
    throw new Error(`Mere source path is not a directory: ${sourcePath}`);
  }
  const [build, zon] = await Promise.all([
    Deno.stat(`${sourcePath}/build.zig`),
    Deno.stat(`${sourcePath}/build.zig.zon`),
  ]);
  if (!build.isFile || !zon.isFile) {
    throw new Error(
      `Mere source path must contain build.zig and build.zig.zon: ${sourcePath}`,
    );
  }
}

function commandResult(
  sourcePath: string,
  argv: string[],
  output: Deno.CommandOutput,
  durationMs: number,
): Record<string, unknown> {
  const stdout = truncate(new TextDecoder().decode(output.stdout));
  const stderr = truncate(new TextDecoder().decode(output.stderr));
  return {
    argv,
    sourcePath,
    exitCode: output.code,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
    durationMs,
    success: output.success,
  };
}

async function execute(
  method: Method,
  sourcePath: string,
  context: ModelContext,
): Promise<Record<string, unknown>> {
  const argv = fixedArgv(method);
  const start = performance.now();
  await requireSourceTree(sourcePath);
  const output = await runCommand(argv, sourcePath, context.signal);
  const result = commandResult(
    sourcePath,
    argv,
    output,
    Math.round(performance.now() - start),
  );
  if (method === "build" || method === "releaseBuild") {
    return {
      ...result,
      binaryPath: `${sourcePath}/${MERE_BINARY_RELATIVE_PATH}`,
      ...(method === "releaseBuild" ? { baseline: true } : {}),
    };
  }
  return result;
}

async function executeAndStore(
  method: Method,
  resource: ResourceName,
  sourcePath: string,
  context: ModelContext,
) {
  try {
    const result = await execute(method, sourcePath, context);
    return {
      dataHandles: [await context.writeResource(resource, "current", result)],
    };
  } catch (error) {
    const result = {
      argv: fixedArgv(method),
      sourcePath,
      exitCode: -1,
      stdout: "",
      stderr: "",
      truncated: false,
      durationMs: 0,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      ...(method === "build" || method === "releaseBuild"
        ? { binaryPath: `${sourcePath}/${MERE_BINARY_RELATIVE_PATH}` }
        : {}),
      ...(method === "releaseBuild" ? { baseline: true } : {}),
    };
    return {
      dataHandles: [await context.writeResource(resource, "current", result)],
    };
  }
}

/** Source-tree validation for the Mere package manager itself. */
export const model = {
  type: "@jeremy/mere-pm-dev",
  version: "2026.08.20.2",
  description:
    "Build and validate an explicit Mere package-manager source tree using fixed, cancellable Zig commands.",
  globalArguments: z.object({}),
  upgrades: [{
    toVersion: "2026.08.20.2",
    description:
      "Move sourcePath from a static model binding to each method so isolated workflow clones are validated in place.",
    upgradeAttributes: (
      _old: Record<string, unknown>,
    ): Record<string, unknown> => ({}),
  }],
  resources: {
    "build-result": {
      description: "Ordinary Mere package-manager build result",
      schema: BuildResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "test-result": {
      description: "Mere package-manager test result",
      schema: CommandResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "baseline-build-result": {
      description: "Portable baseline release build result",
      schema: BaselineBuildResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "smoke-result": {
      description: "Built Mere CLI describe smoke-test result",
      schema: CommandResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    build: {
      description:
        "Build the Mere package-manager source tree with fixed argv `zig build`.",
      arguments: SourcePathArgsSchema,
      execute: async (
        args: z.infer<typeof SourcePathArgsSchema>,
        context: ModelContext,
      ) =>
        await executeAndStore(
          "build",
          "build-result",
          args.sourcePath,
          context,
        ),
    },
    test: {
      description:
        "Run the full Mere package-manager test suite with fixed argv `zig build test --summary all`.",
      arguments: SourcePathArgsSchema,
      execute: async (
        args: z.infer<typeof SourcePathArgsSchema>,
        context: ModelContext,
      ) =>
        await executeAndStore("test", "test-result", args.sourcePath, context),
    },
    releaseBuild: {
      description:
        "Build the portable Mere release artifact with fixed argv `zig build -Doptimize=ReleaseSmall -Dcpu=baseline`.",
      arguments: SourcePathArgsSchema,
      execute: async (
        args: z.infer<typeof SourcePathArgsSchema>,
        context: ModelContext,
      ) =>
        await executeAndStore(
          "releaseBuild",
          "baseline-build-result",
          args.sourcePath,
          context,
        ),
    },
    smoke: {
      description:
        "Run the built Mere CLI's machine-readable describe command with fixed argv `./zig-out/bin/mere describe`.",
      arguments: SourcePathArgsSchema,
      execute: async (
        args: z.infer<typeof SourcePathArgsSchema>,
        context: ModelContext,
      ) =>
        await executeAndStore(
          "smoke",
          "smoke-result",
          args.sourcePath,
          context,
        ),
    },
  },
};
