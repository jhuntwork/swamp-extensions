import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./model_cost.ts";

interface TestResult {
  markdown: string;
  json: {
    workflowName: string;
    totals: {
      runs: number;
      succeeded: number;
      failed: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      durationMs: number;
      reportedCostRuns: number;
    };
    byModel: unknown[];
    runs: Array<{
      effort: string;
      verdict?: string;
      costUsd: number | null;
      model: string;
    }>;
  };
}

function contextFor(
  results: Record<string, unknown>,
  steps: unknown[],
) {
  return {
    workflowName: "test-agent-workflow",
    workflowStatus: "failed" as const,
    stepExecutions: steps as never[],
    dataRepository: {
      getContent: (_type: string, _modelId: string, name: string) =>
        Promise.resolve(
          name in results
            ? new TextEncoder().encode(JSON.stringify(results[name]))
            : null,
        ),
    },
  };
}

Deno.test("model-cost aggregates run and review usage by model", async () => {
  const result = await report.execute(contextFor({
    runResult: {
      output: "done",
      exitCode: 0,
      effort: "low",
      sessionId: "run-session",
      usage: {
        model: "claude-haiku-4-5",
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        costUsd: 0.0123,
        numTurns: 2,
        durationMs: 1200,
        durationApiMs: 900,
      },
    },
    reviewResult: {
      verdict: "fail",
      effort: "high",
      usage: {
        model: "claude-sonnet-4-6",
        inputTokens: 200,
        outputTokens: 80,
        costUsd: 0.0456,
        durationMs: 2300,
      },
    },
  }, [
    {
      jobName: "agent",
      stepName: "run",
      modelName: "runner",
      modelType: "@swamp/agent-runner",
      methodName: "run",
      status: "succeeded",
      dataHandles: [{ name: "runResult", version: 1, specName: "runResult" }],
      methodArgs: { model: "claude-haiku-4-5", effort: "low" },
      modelId: "runner-id",
      globalArgs: { provider: "claude", defaultModel: "claude-haiku-4-5" },
    },
    {
      jobName: "agent",
      stepName: "review",
      modelName: "reviewer",
      modelType: "@swamp/agent-runner",
      methodName: "review",
      status: "failed",
      dataHandles: [{
        name: "reviewResult",
        version: 1,
        specName: "reviewResult",
      }],
      methodArgs: { model: "claude-sonnet-4-6", effort: "high" },
      modelId: "reviewer-id",
      globalArgs: { provider: "claude" },
    },
    {
      jobName: "other",
      stepName: "noop",
      modelName: "not-agent",
      modelType: "@jeremy/mere/recipe",
      methodName: "read",
      status: "succeeded",
      dataHandles: [{ name: "ignored", version: 1, specName: "recipe" }],
      methodArgs: {},
      modelId: "recipe-id",
      globalArgs: {},
    },
  ])) as TestResult;

  assertEquals(result.json.workflowName, "test-agent-workflow");
  assertEquals(result.json.totals.runs, 2);
  assertEquals(result.json.totals.succeeded, 1);
  assertEquals(result.json.totals.failed, 1);
  assertEquals(result.json.totals.inputTokens, 300);
  assertEquals(result.json.totals.outputTokens, 120);
  assertEquals(result.json.totals.costUsd, 0.0579);
  assertEquals(result.json.totals.durationMs, 3500);
  assertEquals(result.json.totals.reportedCostRuns, 2);
  assertEquals(result.json.byModel.length, 2);
  assertEquals(result.json.runs[0].effort, "high");
  assertEquals(result.json.runs[0].verdict, "fail");
  assertEquals(result.json.runs[1].effort, "low");
  assertStringIncludes(result.markdown, "test-agent-workflow");
  assertStringIncludes(result.markdown, "claude-haiku-4-5");
});

Deno.test("model-cost preserves missing usage as not reported", async () => {
  const result = await report.execute(contextFor({
    runResult: { output: "no usage", exitCode: 0 },
  }, [{
    jobName: "agent",
    stepName: "run",
    modelName: "runner",
    modelType: "@swamp/agent-runner",
    methodName: "run",
    status: "succeeded",
    dataHandles: [{ name: "runResult", version: 1, specName: "runResult" }],
    methodArgs: {},
    modelId: "runner-id",
    globalArgs: { provider: "codex", defaultModel: "o4-mini" },
  }])) as TestResult;

  assertEquals(result.json.totals.runs, 1);
  assertEquals(result.json.totals.reportedCostRuns, 0);
  assertEquals(result.json.runs[0].costUsd, null);
  assertEquals(result.json.runs[0].model, "o4-mini");
  assertStringIncludes(result.markdown, "Cost: not reported");
});
