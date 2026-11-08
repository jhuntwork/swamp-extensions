import { join } from "node:path";
import { z } from "npm:zod@4.1.12";
import { runCommand } from "./models/_lib/runner.ts";

const GlobalArgs = z.object({
  toolchain: z.string().min(1).default("mere").describe(
    "Name of the @jeremy/mere/toolchain binding whose provisioned binary and root this profile uses.",
  ),
});

const RunArgs = z.object({
  packages: z.array(z.string().min(1)).min(1).describe(
    "Exact Mere package names to make available in the isolated profile.",
  ),
  argv: z.array(z.string().min(1)).min(1).describe(
    "Exact command argv; argv[0] is the executable. No shell is used.",
  ),
  workdir: z.string().default("/").describe(
    "Working directory for the command. The directory must exist on the host running this step.",
  ),
});

const ResultSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  durationMs: z.number().nonnegative(),
  mereVersion: z.string(),
  mereRoot: z.string(),
  packages: z.array(z.string()),
  argv: z.array(z.string()),
  success: z.boolean(),
  error: z.string().optional(),
});

type Toolchain = {
  binaryPath: string;
  root: string;
  version: string;
};

type Context = {
  repoDir: string;
  signal: AbortSignal;
  globalArgs: z.infer<typeof GlobalArgs>;
  definition: { name: string };
  readModelData: (
    name: string,
    spec?: string,
  ) => Promise<{ attributes: Record<string, unknown> }[]>;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

/** Render one profile file without interpreting package names as KDL. */
export function renderProfile(packages: string[]): string {
  return `profile {\n${
    packages.map((pkg) => `  package ${JSON.stringify(pkg)}`).join("\n")
  }\n}\n`;
}

/** Build the fixed argv passed to Mere's profile shell. */
export function profileArgv(
  mereRoot: string,
  profilePath: string,
  argv: string[],
): string[] {
  return ["--root", mereRoot, "shell", profilePath, "--", ...argv];
}

async function toolchainOf(context: Context): Promise<Toolchain> {
  const name = GlobalArgs.parse(context.globalArgs).toolchain;
  const records = await context.readModelData(name, "toolchain");
  const attributes = records[0]?.attributes;
  const binaryPath = attributes?.binaryPath;
  const root = attributes?.root;
  const version = attributes?.version;
  if (
    typeof binaryPath !== "string" || typeof root !== "string" ||
    typeof version !== "string"
  ) {
    throw new Error(
      `toolchain "${name}" has no provisioned data; run its provision method first`,
    );
  }
  const binaryStat = await Deno.stat(binaryPath);
  if (!binaryStat.isFile) {
    throw new Error(`${binaryPath} is not a regular file`);
  }
  const rootStat = await Deno.stat(root);
  if (!rootStat.isDirectory) throw new Error(`${root} is not a directory`);
  return { binaryPath, root, version };
}

async function writeFailure(
  context: Context,
  args: z.infer<typeof RunArgs>,
  mereVersion: string,
  mereRoot: string,
  error: unknown,
  durationMs: number,
) {
  const message = error instanceof Error ? error.message : String(error);
  return await context.writeResource("result", "current", {
    exitCode: -1,
    stdout: "",
    stderr: "",
    truncated: false,
    durationMs,
    mereVersion,
    mereRoot,
    packages: args.packages,
    argv: args.argv,
    success: false,
    error: message,
  });
}

/** Execute one exact argv in a temporary isolated Mere package profile. */
export const behavior = {
  type: "@jeremy/mere/profile",
  version: "2026.11.08.3",
  description:
    "Run exact argv inside an isolated Mere package profile backed by a provisioned toolchain.",
  upgrades: [{
    toVersion: "2026.11.08.3",
    description:
      "Add the toolchain-backed isolated package profile behavior. Existing behavior instances are unchanged.",
    upgradeAttributes: (
      old: Record<string, unknown>,
    ): Record<string, unknown> => old,
  }],
  globalArguments: GlobalArgs,
  resources: {
    result: {
      description: "Profile command execution result",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    run: {
      description:
        "Create a temporary package profile in the provisioned Mere root and run an exact argv without shell interpretation.",
      kind: "action",
      arguments: RunArgs,
      execute: async (
        raw: z.infer<typeof RunArgs>,
        context: Context,
      ) => {
        const args = RunArgs.parse(raw);
        const started = performance.now();
        let tool: Toolchain | undefined;
        let profilePath = "";
        let resultRecorded = false;
        try {
          tool = await toolchainOf(context);
          const profileDir = join(
            context.repoDir,
            ".swamp",
            "mere",
            "profiles",
          );
          await Deno.mkdir(profileDir, { recursive: true });
          profilePath = await Deno.makeTempFile({
            dir: profileDir,
            prefix: `${
              context.definition.name.replace(/[^A-Za-z0-9._-]/g, "_")
            }-`,
            suffix: ".kdl",
          });
          await Deno.writeTextFile(profilePath, renderProfile(args.packages));
          const result = await runCommand(
            tool.binaryPath,
            profileArgv(tool.root, profilePath, args.argv),
            {
              signal: context.signal,
              cwd: args.workdir,
              timeoutMs: 30 * 60 * 1000,
              maxOutputBytes: 1024 * 1024,
            },
          );
          const data = {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            truncated: result.truncated,
            durationMs: performance.now() - started,
            mereVersion: tool.version,
            mereRoot: tool.root,
            packages: args.packages,
            argv: args.argv,
            success: result.exitCode === 0,
          };
          const handle = await context.writeResource("result", "current", data);
          resultRecorded = true;
          if (result.exitCode !== 0) {
            throw new Error(
              `Mere profile command failed with exit ${result.exitCode}: ${
                (result.stderr || result.stdout).split("\n")[0] ?? ""
              }`,
            );
          }
          return { dataHandles: [handle] };
        } catch (error) {
          if (!resultRecorded) {
            await writeFailure(
              context,
              args,
              tool?.version ?? "",
              tool?.root ?? "",
              error,
              performance.now() - started,
            );
          }
          throw error instanceof Error ? error : new Error(String(error));
        } finally {
          if (profilePath) {
            await Deno.remove(profilePath).catch((error) => {
              if (!(error instanceof Deno.errors.NotFound)) throw error;
            });
          }
        }
      },
    },
  },
};
