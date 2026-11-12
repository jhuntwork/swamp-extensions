/** Snapshot-only Pi work for a Stagecraft triage method stage. @module */
import { z } from "npm:zod@4.6.7";
import {
  Classification,
  parseClassification,
  snapshotInvocation,
} from "./pi_snapshot_protocol.ts";
import { captureProcess, piEnvironment } from "./pi_snapshot_process.ts";

/** Public issue facts supplied as pinned dispatch inputs, never executable instructions. */
export const IssueSnapshot = z.strictObject({
  id: z.string().min(1).max(256),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  number: z.number().int().positive(),
  title: z.string().min(1).max(1024),
  body: z.string().max(64 * 1024),
});
const StagecraftInput = z.object({
  workItem: z.string().min(1),
  dispatchId: z.number().int().positive(),
  resume: z.unknown().optional(),
});
const Arguments = z.strictObject({
  executable: z.string().startsWith("/"),
  expectedPiVersion: z.literal("1.5.2"),
  model: z.string().min(1),
  snapshot: IssueSnapshot,
  _stagecraft: StagecraftInput,
});
const Run = z.object({
  key: z.string(),
  status: z.enum(["active", "terminal"]),
  era: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  stage: z.string(),
  definition: z.object({ digest: z.string().min(1) }),
  entries: z.record(z.string(), z.number().int().positive()),
  externalRefs: z.record(z.string(), z.string()),
  dispatches: z.array(z.object({
    id: z.number().int().positive(),
    era: z.string(),
    stage: z.string(),
    cycle: z.number().int().positive(),
    mode: z.string().optional(),
    prompt: z.string().optional(),
    inputs: z.record(z.string(), z.unknown()),
    method: z.object({ modelIdOrName: z.string(), methodName: z.string() })
      .optional(),
    outcome: z.unknown().optional(),
  })),
});
const Result = z.strictObject({
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  definitionDigest: z.string().min(1),
  era: z.string(),
  cycle: z.number().int().positive(),
  dispatchId: z.number().int().positive(),
  snapshotId: z.string(),
  model: z.string(),
  piVersion: z.literal("1.5.2"),
  classification: Classification,
});
type Args = z.infer<typeof Arguments>;
type Context = {
  definition: { name: string };
  repoDir: string;
  signal: AbortSignal;
  logger: { info(message: string, properties: Record<string, unknown>): void };
  readResource(name: string): Promise<unknown>;
  writeResource(
    spec: string,
    name: string,
    value: unknown,
  ): Promise<{ name: string }>;
};

/** Injectable process boundary for deterministic tests; the exported method uses real Pi. */
export interface TriageRuntime {
  capture: typeof captureProcess;
  environment(): Record<string, string>;
  makeDirectory(path: string): Promise<void>;
}
const runtime: TriageRuntime = {
  capture: captureProcess,
  environment: piEnvironment,
  makeDirectory: (path) => Deno.mkdir(path, { recursive: true, mode: 0o700 }),
};

/** Run only a current, self-targeted method dispatch with exactly its pinned inputs. */
export async function triageSnapshot(
  raw: Args,
  ctx: Context,
  host: TriageRuntime = runtime,
) {
  const args = Arguments.parse(raw);
  const run = Run.parse(await ctx.readResource("run"));
  if (
    run.key !== ctx.definition.name || args._stagecraft.workItem !== run.key
  ) {
    throw new Error("triage-work-item-mismatch");
  }
  if (run.status !== "active" || run.stage !== "triage") {
    throw new Error("triage-stage-mismatch");
  }
  const dispatch = run.dispatches.at(-1);
  if (
    !dispatch || dispatch.id !== args._stagecraft.dispatchId ||
    dispatch.era !== run.era ||
    dispatch.stage !== run.stage || dispatch.cycle !== run.entries[run.stage]
  ) {
    throw new Error("triage-stale-dispatch");
  }
  if (
    dispatch.mode !== "method" || dispatch.method?.modelIdOrName !== run.key ||
    dispatch.method.methodName !== "triage_snapshot"
  ) {
    throw new Error("triage-method-mismatch");
  }
  const pinned = Arguments.parse(dispatch.inputs);
  // Normalize through the declared schema before comparison, so JSON key order
  // is irrelevant. The checkpoint is not task input and is not executed here.
  const taskInput = ({ _stagecraft: _, ...rest }: Args) => rest;
  if (
    JSON.stringify(taskInput(args)) !== JSON.stringify(taskInput(pinned)) ||
    pinned._stagecraft.workItem !== run.key ||
    pinned._stagecraft.dispatchId !== dispatch.id
  ) {
    throw new Error("triage-input-mismatch");
  }
  if (
    args.snapshot.id !== run.externalRefs.github ||
    args.snapshot.id !==
      args.snapshot.repository.replace("/", ".") + "." + args.snapshot.number
  ) {
    throw new Error("triage-issue-mismatch");
  }
  if (!dispatch.prompt?.trim()) throw new Error("triage-missing-prompt");
  // Preserve the pinned system prompt verbatim. Append only the serialized
  // snapshot that is also pinned in dispatch.inputs, with no new instructions.
  const prompt = dispatch.prompt + "\n\n" + JSON.stringify(args.snapshot);
  if (new TextEncoder().encode(prompt).length > 128 * 1024) {
    throw new Error("triage-context-limit");
  }
  const invocation = snapshotInvocation(args.model, prompt);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify({
      definition: run.definition.digest,
      era: run.era,
      cycle: dispatch.cycle,
      dispatchId: dispatch.id,
      task: taskInput(args),
      prompt,
    })),
  );
  const requestDigest = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const name = `triage-result-${run.era}-d${dispatch.id}`;
  const previous = await ctx.readResource(name);
  if (previous != null) {
    if (Result.parse(previous).requestDigest !== requestDigest) {
      throw new Error("triage-result-conflict");
    }
    ctx.logger.info("Reusing triage result for {item} dispatch {dispatch}", {
      item: run.key,
      dispatch: dispatch.id,
    });
    return { dataHandles: [] };
  }
  if (dispatch.outcome !== undefined) throw new Error("triage-dispatch-closed");
  ctx.logger.info("Classifying snapshot for {item} dispatch {dispatch}", {
    item: run.key,
    dispatch: dispatch.id,
  });
  const cwd = `${ctx.repoDir}/.swamp/mere-triage/${requestDigest}`;
  await host.makeDirectory(cwd);
  const common = {
    executable: args.executable,
    cwd,
    env: host.environment(),
    signal: ctx.signal,
  };
  const version = await host.capture({
    ...common,
    args: ["--version"],
    stdin: "",
    timeoutMs: 10_000,
    stdoutLimit: 1024,
    stderrLimit: 4096,
  });
  if (
    version.exitCode !== 0 || version.stdout.trim() !== args.expectedPiVersion
  ) throw new Error("pi-version-mismatch");
  const output = await host.capture({
    ...common,
    ...invocation,
    timeoutMs: 120_000,
  });
  const classification = parseClassification(output.stdout, output.exitCode);
  // Parse explicitly: behavior resource writes may warn rather than throw on
  // schema violations, and no incomplete product may be published as success.
  const result = Result.parse({
    requestDigest,
    definitionDigest: run.definition.digest,
    era: run.era,
    cycle: dispatch.cycle,
    dispatchId: dispatch.id,
    snapshotId: args.snapshot.id,
    model: args.model,
    piVersion: args.expectedPiVersion,
    classification,
  });
  if (ctx.signal.aborted) throw new Error("pi-cancelled");
  const handle = await ctx.writeResource("triageResult", name, result);
  ctx.logger.info("Recorded triage result for {item} dispatch {dispatch}", {
    item: run.key,
    dispatch: dispatch.id,
  });
  return { dataHandles: [handle] };
}

/** Add task execution without changing Stagecraft's engine, gates or lifecycle methods. */
export const extension = {
  type: "@swamp/stagecraft/work-item",
  resources: {
    triageResult: {
      description:
        "Snapshot classification bound to one pinned method dispatch; not a Stagecraft artifact or approval",
      schema: Result,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: [{
    triage_snapshot: {
      description:
        "Classify a pinned triage snapshot with no-tools Pi; never record artifacts or advance the item",
      arguments: Arguments,
      execute: triageSnapshot,
    },
  }],
};
