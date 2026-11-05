import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "../work_cost.ts";

Deno.test("work-cost aggregates imported sessions by repository", async () => {
  const session = {
    schemaVersion: 2,
    id: "session-1",
    repo: "mere-ops",
    harness: "claude-code",
    model: "sonnet",
    startedAt: "2026-11-05T00:00:00Z",
    turns: [
      {
        start: 100,
        end: 250,
        tokens: { input: 10, output: 20, cacheRead: 3, cacheWrite: 4 },
        calls: [
          { label: "swamp" },
          { label: "bypass" },
        ],
      },
      {
        start: 300,
        end: 500,
        tokens: { input: 30, output: 40, cacheRead: 5, cacheWrite: 6 },
        calls: [{ label: "neutral" }],
      },
    ],
  };
  const result = await report.execute({
    modelType: "@swamp/agent-sessions",
    modelId: "sessions",
    methodName: "import",
    dataHandles: [],
    dataRepository: {
      findAllForModel: () =>
        Promise.resolve([
          { name: "session-1", version: 1, specName: "session" },
          { name: "import-index", version: 1, specName: "importIndex" },
        ]),
      getContent: (_type, _modelId, name) =>
        Promise.resolve(
          name === "session-1"
            ? new TextEncoder().encode(JSON.stringify(session))
            : null,
        ),
    },
  });

  assertEquals(result.json.sessionCount, 1);
  assertEquals(result.json.totals, {
    sessions: 1,
    turns: 2,
    toolCalls: 3,
    inputTokens: 40,
    outputTokens: 60,
    cacheReadTokens: 8,
    cacheWriteTokens: 10,
    wallTimeMs: 400,
    swampCalls: 1,
    bypassCalls: 1,
    neutralCalls: 1,
  });
  assertStringIncludes(result.markdown, "mere-ops");
  assertStringIncludes(result.markdown, "Bypass: 1");
});
