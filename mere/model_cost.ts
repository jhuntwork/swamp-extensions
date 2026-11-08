interface Handle {
  name: string;
  version: number;
  specName: string;
}

interface Usage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningOutputTokens?: number;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  durationApiMs?: number;
}

interface AgentResult {
  effort?: string;
  sessionId?: string;
  usage?: Usage;
  verdict?: "pass" | "fail";
  exitCode?: number;
  capacityStop?: boolean;
}

interface Step {
  jobName: string;
  stepName: string;
  modelName: string;
  modelType: string;
  methodName: string;
  status: "succeeded" | "failed" | "skipped";
  dataHandles: Handle[];
  methodArgs: Record<string, unknown>;
  modelId: string;
  globalArgs: Record<string, unknown>;
}

interface Context {
  workflowName: string;
  workflowStatus: "succeeded" | "failed";
  stepExecutions: Step[];
  dataRepository: {
    getContent(
      type: string,
      modelId: string,
      name: string,
      version?: number,
    ): Promise<Uint8Array | null>;
  };
}

type AgentRun = {
  jobName: string;
  stepName: string;
  modelName: string;
  provider: string;
  model: string;
  method: string;
  effort: string;
  status: string;
  outcome: string;
  verdict?: string;
  capacityStop: boolean;
  sessionId?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningOutputTokens: number | null;
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  durationApiMs: number | null;
};

type Totals = {
  runs: number;
  succeeded: number;
  failed: number;
  skipped: number;
  capacityStops: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningOutputTokens: number;
  costUsd: number;
  reportedInputTokenRuns: number;
  reportedOutputTokenRuns: number;
  reportedCacheReadTokenRuns: number;
  reportedCacheWriteTokenRuns: number;
  reportedReasoningTokenRuns: number;
  reportedCostRuns: number;
  reportedDurationRuns: number;
  durationMs: number;
  durationApiMs: number;
  reportedDurationApiRuns: number;
};

function emptyTotals(): Totals {
  return {
    runs: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    capacityStops: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningOutputTokens: 0,
    costUsd: 0,
    reportedInputTokenRuns: 0,
    reportedOutputTokenRuns: 0,
    reportedCacheReadTokenRuns: 0,
    reportedCacheWriteTokenRuns: 0,
    reportedReasoningTokenRuns: 0,
    reportedCostRuns: 0,
    reportedDurationRuns: 0,
    durationMs: 0,
    durationApiMs: 0,
    reportedDurationApiRuns: 0,
  };
}

function addOptional(
  totals: Totals,
  field: keyof Pick<
    Totals,
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "reasoningOutputTokens"
    | "costUsd"
    | "durationMs"
    | "durationApiMs"
  >,
  reportedField: keyof Pick<
    Totals,
    | "reportedInputTokenRuns"
    | "reportedOutputTokenRuns"
    | "reportedCacheReadTokenRuns"
    | "reportedCacheWriteTokenRuns"
    | "reportedReasoningTokenRuns"
    | "reportedCostRuns"
    | "reportedDurationRuns"
    | "reportedDurationApiRuns"
  >,
  value: number | undefined,
): void {
  if (value === undefined || !Number.isFinite(value)) return;
  totals[field] += value;
  totals[reportedField] += 1;
}

function addRun(totals: Totals, run: AgentRun): void {
  totals.runs += 1;
  if (run.status === "succeeded") totals.succeeded += 1;
  else if (run.status === "failed") totals.failed += 1;
  else totals.skipped += 1;
  if (run.capacityStop) totals.capacityStops += 1;
  addOptional(
    totals,
    "inputTokens",
    "reportedInputTokenRuns",
    run.inputTokens ?? undefined,
  );
  addOptional(
    totals,
    "outputTokens",
    "reportedOutputTokenRuns",
    run.outputTokens ?? undefined,
  );
  addOptional(
    totals,
    "cacheReadTokens",
    "reportedCacheReadTokenRuns",
    run.cacheReadTokens ?? undefined,
  );
  addOptional(
    totals,
    "cacheWriteTokens",
    "reportedCacheWriteTokenRuns",
    run.cacheWriteTokens ?? undefined,
  );
  addOptional(
    totals,
    "reasoningOutputTokens",
    "reportedReasoningTokenRuns",
    run.reasoningOutputTokens ?? undefined,
  );
  addOptional(totals, "costUsd", "reportedCostRuns", run.costUsd ?? undefined);
  addOptional(
    totals,
    "durationMs",
    "reportedDurationRuns",
    run.durationMs ?? undefined,
  );
  addOptional(
    totals,
    "durationApiMs",
    "reportedDurationApiRuns",
    run.durationApiMs ?? undefined,
  );
}

function modelName(step: Step, result: AgentResult): string {
  const usageModel = result.usage?.model;
  if (usageModel) return usageModel;
  const requested = step.methodArgs.model;
  if (typeof requested === "string" && requested) return requested;
  const configured = step.globalArgs.defaultModel;
  return typeof configured === "string" ? configured : "";
}

function providerName(step: Step): string {
  const provider = step.globalArgs.provider;
  return typeof provider === "string" ? provider : "unknown";
}

function resultOutcome(step: Step, result: AgentResult): string {
  if (result.capacityStop) return "capacity-stop";
  if (step.methodName === "review" && result.verdict) return result.verdict;
  if (step.methodName === "run" && result.exitCode !== undefined) {
    return result.exitCode === 0 ? "passed" : "failed";
  }
  return step.status;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseRun(step: Step, result: AgentResult): AgentRun {
  const usage = result.usage;
  return {
    jobName: step.jobName,
    stepName: step.stepName,
    modelName: step.modelName,
    provider: providerName(step),
    model: modelName(step, result),
    method: step.methodName,
    effort: result.effort ??
      (typeof step.methodArgs.effort === "string"
        ? step.methodArgs.effort
        : ""),
    status: step.status,
    outcome: resultOutcome(step, result),
    ...(result.verdict ? { verdict: result.verdict } : {}),
    capacityStop: result.capacityStop === true,
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    inputTokens: optionalNumber(usage?.inputTokens),
    outputTokens: optionalNumber(usage?.outputTokens),
    cacheReadTokens: optionalNumber(usage?.cacheReadTokens),
    cacheWriteTokens: optionalNumber(usage?.cacheWriteTokens),
    reasoningOutputTokens: optionalNumber(usage?.reasoningOutputTokens),
    costUsd: optionalNumber(usage?.costUsd),
    numTurns: optionalNumber(usage?.numTurns),
    durationMs: optionalNumber(usage?.durationMs),
    durationApiMs: optionalNumber(usage?.durationApiMs),
  };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCost(value: number, reportedRuns: number): string {
  return reportedRuns > 0 ? `$${value.toFixed(4)}` : "not reported";
}

function formatDuration(value: number, reportedRuns: number): string {
  return reportedRuns > 0 ? `${Math.round(value / 1000)} s` : "not reported";
}

function markdown(
  workflowName: string,
  workflowStatus: string,
  totals: Totals,
  byModel: Array<
    { key: string; provider: string; model: string; totals: Totals }
  >,
  runs: AgentRun[],
): string {
  const lines = [
    "# Model cost",
    "",
    `Workflow: ${workflowName}. Status: ${workflowStatus}. Runs: ${totals.runs}.`,
    `Cost: ${formatCost(totals.costUsd, totals.reportedCostRuns)}. Duration: ${
      formatDuration(totals.durationMs, totals.reportedDurationRuns)
    }.`,
    `Tokens: ${formatNumber(totals.inputTokens)} input, ${
      formatNumber(totals.outputTokens)
    } output, ${formatNumber(totals.cacheReadTokens)} cache-read, ${
      formatNumber(totals.cacheWriteTokens)
    } cache-write, ${
      formatNumber(totals.reasoningOutputTokens)
    } reasoning output.`,
    `Outcomes: ${totals.succeeded} succeeded, ${totals.failed} failed, ${totals.capacityStops} capacity stops.`,
    "",
    "| Provider | Model | Runs | Cost | Input | Output | Duration |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const entry of byModel) {
    lines.push(
      `| ${entry.provider} | ${
        entry.model || "not reported"
      } | ${entry.totals.runs} | ${
        formatCost(entry.totals.costUsd, entry.totals.reportedCostRuns)
      } | ${formatNumber(entry.totals.inputTokens)} | ${
        formatNumber(entry.totals.outputTokens)
      } | ${
        formatDuration(
          entry.totals.durationMs,
          entry.totals.reportedDurationRuns,
        )
      } |`,
    );
  }
  if (runs.length > 0) {
    lines.push(
      "",
      "| Job | Step | Method | Model | Effort | Status | Outcome | Cost |",
      "| --- | --- | --- | --- | --- | --- | --- | ---: |",
    );
    for (const run of runs) {
      lines.push(
        `| ${run.jobName} | ${run.stepName} | ${run.method} | ${
          run.model || "not reported"
        } | ${run.effort || "default"} | ${run.status} | ${run.outcome} | ${
          run.costUsd === null ? "not reported" : `$${run.costUsd.toFixed(4)}`
        } |`,
      );
    }
  }
  return lines.join("\n");
}

/** Workflow report aggregating structured usage from @swamp/agent-runner steps. */
export const report = {
  name: "@jeremy/mere/model-cost",
  description:
    "Summarize agent-runner model, effort, token, cost, duration, and outcome data for a workflow.",
  scope: "workflow",
  labels: ["mere", "agent", "model", "cost"],
  execute: async (context: Context) => {
    const totals = emptyTotals();
    const byModelMap = new Map<
      string,
      { provider: string; model: string; totals: Totals }
    >();
    const runs: AgentRun[] = [];

    for (const step of context.stepExecutions) {
      if (!step.modelType.includes("agent-runner")) continue;
      for (const handle of step.dataHandles ?? []) {
        if (
          handle.specName !== "runResult" && handle.specName !== "reviewResult"
        ) continue;
        const bytes = await context.dataRepository.getContent(
          step.modelType,
          step.modelId,
          handle.name,
          handle.version,
        );
        if (!bytes) continue;
        const result = JSON.parse(
          new TextDecoder().decode(bytes),
        ) as AgentResult;
        const run = parseRun(step, result);
        runs.push(run);
        addRun(totals, run);
        const key = `${run.provider}\u0000${run.model}`;
        let entry = byModelMap.get(key);
        if (!entry) {
          entry = {
            provider: run.provider,
            model: run.model,
            totals: emptyTotals(),
          };
          byModelMap.set(key, entry);
        }
        addRun(entry.totals, run);
      }
    }

    runs.sort((a, b) =>
      `${a.jobName}/${a.stepName}`.localeCompare(`${b.jobName}/${b.stepName}`)
    );
    const byModel = [...byModelMap.entries()].map(([key, entry]) => ({
      key,
      ...entry,
    })).sort((a, b) => a.key.localeCompare(b.key));

    return {
      markdown: markdown(
        context.workflowName,
        context.workflowStatus,
        totals,
        byModel,
        runs,
      ),
      json: {
        workflowName: context.workflowName,
        workflowStatus: context.workflowStatus,
        totals,
        byModel,
        runs,
      },
    };
  },
};
