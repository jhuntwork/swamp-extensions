// ABOUTME: Bounded Swamp model for building and validating the Mere package-manager source tree.
// ABOUTME: Runs fixed Zig argv inside a @jeremy/mere-shell namespace; it has no release acquisition, recipe, or publishing authority.
// deno-lint-ignore-file no-import-prefix
import { z } from "npm:zod@4.4.3";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MERE_BINARY_RELATIVE_PATH = "zig-out/bin/mere";

export type Method = "fmtCheck" | "build" | "test" | "releaseBuild" | "smoke";
type ResourceName =
  | "fmt-result"
  | "build-result"
  | "test-result"
  | "baseline-build-result"
  | "smoke-result";

/** Packages of the Mere project's own development profile. */
export const DEV_PACKAGES = [
  "zig",
  "bash",
  "busybox",
  "ca-certs",
  "cmake",
  "curl",
  "llvm",
  "make",
  "musl-dev",
  "perl",
  "pkgconf",
  "python",
] as const;

const PackageNameSchema = z.string().regex(
  /^[A-Za-z0-9@._+:/-]+$/,
  "package names may contain only package identifier characters",
);

const GlobalArgsSchema = z.object({
  shell: z.string().min(1).default("mere-shell-pm").describe(
    "Name of the @jeremy/mere-shell definition that runs every command. It is created on first use with default settings; create it first to pin a Mere version or root.",
  ),
  packages: z.array(PackageNameSchema).min(1).default([...DEV_PACKAGES])
    .describe(
      "Packages available inside the shell. The default matches the Mere project's development profile.",
    ),
});

type ShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  success: boolean;
  error?: string;
};

type RunModelResult =
  | { ok: true; resources: Array<{ attributes?: Record<string, unknown> }> }
  | { ok: false; error: { message: string } };

type ModelContext = {
  signal?: AbortSignal;
  globalArgs?: z.infer<typeof GlobalArgsSchema>;
  logger?: {
    info: (message: string, fields?: Record<string, unknown>) => void;
  };
  writeResource: (
    name: ResourceName,
    key: string,
    attributes: Record<string, unknown>,
  ) => Promise<unknown>;
  runModel?: (options: Record<string, unknown>) => Promise<RunModelResult>;
  readModelData?: (
    name: string,
    spec?: string,
  ) => Promise<Array<{ attributes: Record<string, unknown> }>>;
};

const SourcePathArgsSchema = z.object({
  sourcePath: z.string().min(1).refine(
    (value) => value.startsWith("/"),
    "sourcePath must be an absolute path",
  ).describe(
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

/** Return the stable resource spec and instance identity for one method result. */
export function resultIdentity(method: Method): ResourceName {
  switch (method) {
    case "fmtCheck":
      return "fmt-result";
    case "build":
      return "build-result";
    case "test":
      return "test-result";
    case "releaseBuild":
      return "baseline-build-result";
    case "smoke":
      return "smoke-result";
  }
}

/** Return the exact fixed argv associated with one bounded validation method. */
export function fixedArgv(method: Method): string[] {
  switch (method) {
    case "fmtCheck":
      return ["zig", "fmt", "--check", "src", "build.zig", "build.zig.zon"];
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

/** Run an exact argv in a Mere shell namespace whose working directory is the source tree. */
export async function runInShell(
  argv: string[],
  cwd: string,
  context: ModelContext,
): Promise<ShellResult> {
  if (!context.runModel) {
    throw new Error("runModel is unavailable here; run this model locally");
  }
  const globals = GlobalArgsSchema.parse(context.globalArgs ?? {});
  context.logger?.info("Running {argv} in the {shell} namespace", {
    argv: argv.join(" "),
    shell: globals.shell,
  });
  const result = await context.runModel({
    modelType: "@jeremy/mere-shell",
    name: globals.shell,
    method: "run",
    arguments: { packages: globals.packages, argv, workdir: cwd },
  });
  if (!result.ok) {
    throw new Error(`mere-shell ${globals.shell}: ${result.error.message}`);
  }
  let attributes = result.resources[0]?.attributes;
  if (!attributes && context.readModelData) {
    attributes = (await context.readModelData(globals.shell, "result"))[0]
      ?.attributes;
  }
  if (!attributes) {
    throw new Error(`mere-shell ${globals.shell} returned no result`);
  }
  return attributes as ShellResult;
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
  output: ShellResult,
  durationMs: number,
): Record<string, unknown> {
  const stdout = truncate(output.stdout);
  const stderr = truncate(output.stderr);
  return {
    argv,
    sourcePath,
    exitCode: output.exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: output.truncated || stdout.truncated || stderr.truncated,
    durationMs,
    success: output.success,
    ...(output.error ? { error: output.error } : {}),
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
  const output = await runInShell(argv, sourcePath, context);
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
  sourcePath: string,
  context: ModelContext,
) {
  const identity = resultIdentity(method);
  try {
    const result = await execute(method, sourcePath, context);
    return {
      dataHandles: [await context.writeResource(identity, identity, result)],
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
      dataHandles: [await context.writeResource(identity, identity, result)],
    };
  }
}

/** Source-tree validation for the Mere package manager itself. */
export const model = {
  type: "@jeremy/mere-pm-dev",
  version: "2026.11.13.4",
  description:
    "Build and validate an explicit Mere package-manager source tree using fixed Zig commands run in a Mere shell namespace.",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.08.20.2",
      description:
        "Move sourcePath from a static model binding to each method so isolated workflow clones are validated in place.",
      upgradeAttributes: (
        _old: Record<string, unknown>,
      ): Record<string, unknown> => ({}),
    },
    {
      toVersion: "2026.08.23.1",
      description:
        "Give build, test, portable-build, and smoke evidence distinct stable instance identities.",
      upgradeAttributes: (
        _old: Record<string, unknown>,
      ): Record<string, unknown> => ({}),
    },
    {
      toVersion: "2026.11.03.1",
      description:
        "Align the model version with the published manifest; global arguments unchanged.",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.11.10.1",
      description:
        "Pin zod, require absolute source paths, and document fixed subprocess execution. Global arguments unchanged.",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.11.13.1",
      description:
        "Delivery workflow passes change facts straight to the GitHub adapter and no longer depends on a change-packet model. Global arguments unchanged.",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.11.13.2",
      description:
        "Add the fmtCheck method and fmt-result resource. Global arguments unchanged.",
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
      toVersion: "2026.11.13.4",
      description:
        "Run every command inside a @jeremy/mere-shell namespace instead of on the host, and add the shell and packages global arguments with defaults.",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => ({
        shell: "mere-shell-pm",
        packages: [...DEV_PACKAGES],
        ...old,
      }),
    },
  ],
  resources: {
    "fmt-result": {
      description: "Mere package-manager formatting check result",
      schema: CommandResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
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
    fmtCheck: {
      description:
        "Check Zig formatting of the Mere package-manager source with fixed argv `zig fmt --check src build.zig build.zig.zon`.",
      arguments: SourcePathArgsSchema,
      execute: async (
        args: z.infer<typeof SourcePathArgsSchema>,
        context: ModelContext,
      ) => await executeAndStore("fmtCheck", args.sourcePath, context),
    },
    build: {
      description:
        "Build the Mere package-manager source tree with fixed argv `zig build`.",
      arguments: SourcePathArgsSchema,
      execute: async (
        args: z.infer<typeof SourcePathArgsSchema>,
        context: ModelContext,
      ) => await executeAndStore("build", args.sourcePath, context),
    },
    test: {
      description:
        "Run the full Mere package-manager test suite with fixed argv `zig build test --summary all`.",
      arguments: SourcePathArgsSchema,
      execute: async (
        args: z.infer<typeof SourcePathArgsSchema>,
        context: ModelContext,
      ) => await executeAndStore("test", args.sourcePath, context),
    },
    releaseBuild: {
      description:
        "Build the portable Mere release artifact with fixed argv `zig build -Doptimize=ReleaseSmall -Dcpu=baseline`.",
      arguments: SourcePathArgsSchema,
      execute: async (
        args: z.infer<typeof SourcePathArgsSchema>,
        context: ModelContext,
      ) => await executeAndStore("releaseBuild", args.sourcePath, context),
    },
    smoke: {
      description:
        "Run the built Mere CLI's machine-readable describe command with fixed argv `./zig-out/bin/mere describe`.",
      arguments: SourcePathArgsSchema,
      execute: async (
        args: z.infer<typeof SourcePathArgsSchema>,
        context: ModelContext,
      ) => await executeAndStore("smoke", args.sourcePath, context),
    },
  },
};
