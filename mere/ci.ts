import { z } from "npm:zod@4.1.12";
import { runCommand } from "./models/_lib/runner.ts";

const GlobalArgs = z.object({
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/).default(
    "jhuntwork/merelinux",
  ),
  workflow: z.string().min(1).default("build.yaml"),
});

const RunSchema = z.object({
  runId: z.number().int().positive(),
  repository: z.string(),
  workflow: z.string(),
  expectedCommit: z.string().regex(/^[0-9a-f]{40,64}$/i),
  headSha: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  url: z.string(),
  event: z.string(),
  displayTitle: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  durationMs: z.number().nonnegative(),
  checkedAt: z.string(),
  schemaVersion: z.literal(1),
});

const DispatchSchema = z.object({
  repository: z.string(),
  workflow: z.string(),
  ref: z.string(),
  recipes: z.array(z.string().min(1)),
  queuedAt: z.string(),
  schemaVersion: z.literal(1),
});

const RunArgs = z.object({
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/).optional(),
  workflow: z.string().min(1).optional(),
  commit: z.string().regex(/^[0-9a-f]{40,64}$/i),
  discoveryTimeoutSeconds: z.number().int().min(1).max(600).default(120),
  pollIntervalSeconds: z.number().int().min(1).max(60).default(5),
});

const WaitArgs = z.object({
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/).optional(),
  runId: z.number().int().positive(),
  expectedCommit: z.string().regex(/^[0-9a-f]{40,64}$/i).optional(),
  timeoutSeconds: z.number().int().min(1).max(86_400).default(3_600),
  pollIntervalSeconds: z.number().int().min(1).max(60).default(15),
});

const DispatchArgs = z.object({
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/).optional(),
  workflow: z.string().min(1).optional(),
  ref: z.string().min(1).default("main"),
  recipes: z.array(z.string().min(1)).min(1),
});

type GhRun = {
  databaseId?: unknown;
  status?: unknown;
  conclusion?: unknown;
  url?: unknown;
  headSha?: unknown;
  event?: unknown;
  displayTitle?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

type Context = {
  signal: AbortSignal;
  globalArgs: z.infer<typeof GlobalArgs>;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

const RUN_FIELDS = [
  "databaseId",
  "status",
  "conclusion",
  "url",
  "headSha",
  "event",
  "displayTitle",
  "createdAt",
  "updatedAt",
].join(",");

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`GitHub run has no ${field}`);
  return value;
}

function runIdValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("GitHub run has no valid databaseId");
  }
  return value;
}

/** Parse and sort the stable fields returned by `gh run list`. */
export function parseRunList(raw: string): GhRun[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) {
    throw new Error("gh run list did not return an array");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("invalid GitHub run");
    }
    return item as GhRun;
  }).sort((a, b) =>
    stringValue(b.updatedAt, "updatedAt").localeCompare(
      stringValue(a.updatedAt, "updatedAt"),
    )
  );
}

/** Parse one run returned by `gh run view`. */
export function parseRun(raw: string): GhRun {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("gh run view did not return an object");
  }
  return value as GhRun;
}

function durationOf(createdAt: string, updatedAt: string): number {
  const created = Date.parse(createdAt);
  const updated = Date.parse(updatedAt);
  return Number.isFinite(created) && Number.isFinite(updated)
    ? Math.max(0, updated - created)
    : 0;
}

function runResource(
  run: GhRun,
  repository: string,
  workflow: string,
  expectedCommit: string,
): z.infer<typeof RunSchema> {
  const createdAt = stringValue(run.createdAt, "createdAt");
  const updatedAt = stringValue(run.updatedAt, "updatedAt");
  return RunSchema.parse({
    runId: runIdValue(run.databaseId),
    repository,
    workflow,
    expectedCommit: expectedCommit.toLowerCase(),
    headSha: stringValue(run.headSha, "headSha").toLowerCase(),
    status: stringValue(run.status, "status"),
    conclusion: run.conclusion === null || run.conclusion === undefined
      ? null
      : stringValue(run.conclusion, "conclusion"),
    url: stringValue(run.url, "url"),
    event: stringValue(run.event, "event"),
    displayTitle: stringValue(run.displayTitle, "displayTitle"),
    createdAt,
    updatedAt,
    durationMs: durationOf(createdAt, updatedAt),
    checkedAt: new Date().toISOString(),
    schemaVersion: 1,
  });
}

async function gh(
  args: string[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  const result = await runCommand("gh", args, {
    signal,
    timeoutMs,
    maxOutputBytes: 128 * 1024,
  });
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n")[0] ?? "";
    throw new Error(
      `gh ${args[0] ?? "command"} failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout;
}

async function sleep(seconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("cancelled"));
    };
    setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, seconds * 1_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function globals(
  context: Context,
  args: { repository?: string; workflow?: string },
) {
  const bound = GlobalArgs.parse(context.globalArgs);
  return {
    repository: args.repository ?? bound.repository,
    workflow: args.workflow ?? bound.workflow,
  };
}

export const behavior = {
  type: "@jeremy/mere/ci",
  version: "2026.11.08.1",
  description:
    "Observe the authoritative Merelinux GitHub Actions build and publish run without storing GitHub credentials.",
  globalArguments: GlobalArgs,
  resources: {
    ciRun: {
      description: "One GitHub Actions run observed for an exact commit",
      schema: RunSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    ciDispatch: {
      description: "A recorded GitHub Actions workflow dispatch request",
      schema: DispatchSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    runsForCommit: {
      description:
        "Find the newest workflow run for an exact commit. GitHub may create " +
        "the Actions run just after delivering a push webhook, so discovery " +
        "polls for a bounded time before failing.",
      kind: "read",
      arguments: RunArgs,
      execute: async (raw: z.infer<typeof RunArgs>, context: Context) => {
        const args = RunArgs.parse(raw);
        const { repository, workflow } = globals(context, args);
        const deadline = Date.now() + args.discoveryTimeoutSeconds * 1_000;
        let runs: GhRun[] = [];
        while (true) {
          context.signal.throwIfAborted();
          const output = await gh(
            [
              "run",
              "list",
              "--repo",
              repository,
              "--workflow",
              workflow,
              "--commit",
              args.commit,
              "--json",
              RUN_FIELDS,
              "--limit",
              "20",
            ],
            context.signal,
            30_000,
          );
          runs = parseRunList(output);
          if (runs.length > 0) break;
          if (Date.now() >= deadline) {
            throw new Error(
              `no ${workflow} Actions run found for ${args.commit} in ${repository}`,
            );
          }
          await sleep(
            Math.min(
              args.pollIntervalSeconds,
              Math.max(
                1,
                Math.ceil((deadline - Date.now()) / 1_000),
              ),
            ),
            context.signal,
          );
        }
        const selected = runResource(
          runs[0],
          repository,
          workflow,
          args.commit,
        );
        if (selected.headSha !== args.commit.toLowerCase()) {
          throw new Error(
            `Actions run ${selected.runId} head ${selected.headSha} does not match requested commit ${args.commit}`,
          );
        }
        const handle = await context.writeResource(
          "ciRun",
          `commit-${args.commit.toLowerCase()}`,
          selected,
        );
        return { dataHandles: [handle] };
      },
    },
    waitForRun: {
      description:
        "Poll one GitHub Actions run until it completes, record its final " +
        "conclusion, and throw after recording a non-success conclusion.",
      kind: "action",
      arguments: WaitArgs,
      execute: async (raw: z.infer<typeof WaitArgs>, context: Context) => {
        const args = WaitArgs.parse(raw);
        const { repository, workflow } = globals(context, args);
        const deadline = Date.now() + args.timeoutSeconds * 1_000;
        let run: GhRun;
        while (true) {
          context.signal.throwIfAborted();
          run = parseRun(
            await gh(
              [
                "run",
                "view",
                String(args.runId),
                "--repo",
                repository,
                "--json",
                RUN_FIELDS,
              ],
              context.signal,
              30_000,
            ),
          );
          const headSha = stringValue(run.headSha, "headSha").toLowerCase();
          if (
            args.expectedCommit && headSha !== args.expectedCommit.toLowerCase()
          ) {
            throw new Error(
              `Actions run ${args.runId} head ${headSha} does not match expected commit ${args.expectedCommit}`,
            );
          }
          if (stringValue(run.status, "status") === "completed") break;
          if (Date.now() >= deadline) {
            throw new Error(
              `Actions run ${args.runId} did not complete within ${args.timeoutSeconds} seconds`,
            );
          }
          await sleep(
            Math.min(
              args.pollIntervalSeconds,
              Math.max(
                1,
                Math.ceil((deadline - Date.now()) / 1_000),
              ),
            ),
            context.signal,
          );
        }
        const selected = runResource(
          run,
          repository,
          workflow,
          args.expectedCommit ?? stringValue(run.headSha, "headSha"),
        );
        const handle = await context.writeResource(
          "ciRun",
          `run-${args.runId}`,
          selected,
        );
        if (selected.conclusion !== "success") {
          throw new Error(
            `Actions run ${args.runId} finished with ${
              selected.conclusion ?? "no conclusion"
            }: ${selected.url}`,
          );
        }
        return { dataHandles: [handle] };
      },
    },
    dispatch: {
      description:
        "Dispatch a named GitHub Actions workflow with the newline-separated " +
        "recipe paths expected by Merelinux build.yaml.",
      kind: "action",
      arguments: DispatchArgs,
      execute: async (raw: z.infer<typeof DispatchArgs>, context: Context) => {
        const args = DispatchArgs.parse(raw);
        const { repository, workflow } = globals(context, args);
        await gh(
          [
            "workflow",
            "run",
            workflow,
            "--repo",
            repository,
            "--ref",
            args.ref,
            "--field",
            `recipes=${args.recipes.join("\n")}`,
          ],
          context.signal,
          30_000,
        );
        const data = DispatchSchema.parse({
          repository,
          workflow,
          ref: args.ref,
          recipes: args.recipes,
          queuedAt: new Date().toISOString(),
          schemaVersion: 1,
        });
        const handle = await context.writeResource(
          "ciDispatch",
          `dispatch-${Date.now()}`,
          data,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
