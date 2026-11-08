interface DataRef {
  name: string;
  version?: number;
  specName?: string;
  tags?: Record<string, string>;
}

interface Turn {
  start: number;
  end: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  calls: Array<{ label?: string }>;
}

interface SessionRecord {
  schemaVersion: number;
  id: string;
  repo: string;
  harness: string;
  model?: string;
  startedAt: string;
  turns: Turn[];
}

interface Context {
  modelType: string;
  modelId: string;
  methodName: string;
  dataHandles: DataRef[];
  dataRepository: {
    findAllForModel(type: string, modelId: string): Promise<DataRef[]>;
    getContent(
      type: string,
      modelId: string,
      name: string,
      version?: number,
    ): Promise<Uint8Array | null>;
  };
}

interface CostTotals {
  sessions: number;
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  wallTimeMs: number;
  swampCalls: number;
  bypassCalls: number;
  neutralCalls: number;
}

function emptyTotals(): CostTotals {
  return {
    sessions: 0,
    turns: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    wallTimeMs: 0,
    swampCalls: 0,
    bypassCalls: 0,
    neutralCalls: 0,
  };
}

function addSession(totals: CostTotals, session: SessionRecord): void {
  totals.sessions += 1;
  totals.turns += session.turns.length;
  let first = Number.POSITIVE_INFINITY;
  let last = 0;
  for (const turn of session.turns) {
    first = Math.min(first, turn.start);
    last = Math.max(last, turn.end);
    totals.inputTokens += turn.tokens.input;
    totals.outputTokens += turn.tokens.output;
    totals.cacheReadTokens += turn.tokens.cacheRead;
    totals.cacheWriteTokens += turn.tokens.cacheWrite;
    totals.toolCalls += turn.calls.length;
    for (const call of turn.calls) {
      if (call.label === "swamp") totals.swampCalls += 1;
      else if (call.label === "bypass") totals.bypassCalls += 1;
      else if (call.label === "neutral") totals.neutralCalls += 1;
    }
  }
  if (Number.isFinite(first)) totals.wallTimeMs += Math.max(0, last - first);
}

type RepoTotals = CostTotals & { repo: string };

function markdown(totals: CostTotals, byRepo: RepoTotals[]): string {
  const lines = [
    "# Agent work cost",
    "",
    `Sessions: ${totals.sessions}. Turns: ${totals.turns}. Tool calls: ${totals.toolCalls}.`,
    `Tokens: ${totals.inputTokens} input, ${totals.outputTokens} output, ${totals.cacheReadTokens} cache-read, ${totals.cacheWriteTokens} cache-write.`,
    `Wall time: ${
      Math.round(totals.wallTimeMs / 1000)
    } seconds. Swamp: ${totals.swampCalls}. Bypass: ${totals.bypassCalls}. Neutral: ${totals.neutralCalls}.`,
    "",
    "| Repository | Sessions | Turns | Tool calls | Input | Output | Wall time | Bypass |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const entry of byRepo) {
    lines.push(
      `| ${
        entry.repo ?? "unknown"
      } | ${entry.sessions} | ${entry.turns} | ${entry.toolCalls} | ${entry.inputTokens} | ${entry.outputTokens} | ${
        Math.round(entry.wallTimeMs / 1000)
      } s | ${entry.bypassCalls} |`,
    );
  }
  return lines.join("\n");
}

/** Method report aggregating imported coding-agent session costs. */
export const report = {
  name: "@jeremy/mere/work-cost",
  description:
    "Summarize imported coding-agent sessions, token counts, wall time, tool calls and bypass labels.",
  scope: "method",
  labels: ["mere", "agent", "cost"],
  execute: async (context: Context) => {
    const totals = emptyTotals();
    const byRepoMap = new Map<string, CostTotals>();
    const sessions: Array<{
      id: string;
      repo: string;
      harness: string;
      model?: string;
      startedAt: string;
      turns: number;
      toolCalls: number;
      inputTokens: number;
      outputTokens: number;
      wallTimeMs: number;
      bypassCalls: number;
    }> = [];
    const refs = await context.dataRepository.findAllForModel(
      context.modelType,
      context.modelId,
    );
    for (const ref of refs) {
      if (
        ref.specName !== "session" &&
        ref.tags?.specName !== "session"
      ) continue;
      const bytes = await context.dataRepository.getContent(
        context.modelType,
        context.modelId,
        ref.name,
        ref.version,
      );
      if (!bytes) continue;
      const value = JSON.parse(
        new TextDecoder().decode(bytes),
      ) as SessionRecord;
      if (value.schemaVersion !== 2 || !Array.isArray(value.turns)) continue;
      addSession(totals, value);
      let repoTotals = byRepoMap.get(value.repo);
      if (!repoTotals) {
        repoTotals = emptyTotals();
        byRepoMap.set(value.repo, repoTotals);
      }
      addSession(repoTotals, value);
      const sessionTotals = emptyTotals();
      addSession(sessionTotals, value);
      sessions.push({
        id: value.id,
        repo: value.repo,
        harness: value.harness,
        model: value.model,
        startedAt: value.startedAt,
        turns: sessionTotals.turns,
        toolCalls: sessionTotals.toolCalls,
        inputTokens: sessionTotals.inputTokens,
        outputTokens: sessionTotals.outputTokens,
        wallTimeMs: sessionTotals.wallTimeMs,
        bypassCalls: sessionTotals.bypassCalls,
      });
    }
    const byRepo: RepoTotals[] = [...byRepoMap.entries()].map((
      [repo, values],
    ) => ({
      repo,
      ...values,
    })).sort((a, b) => a.repo.localeCompare(b.repo));
    return {
      markdown: markdown(totals, byRepo),
      json: {
        method: context.methodName,
        sessionCount: totals.sessions,
        totals,
        byRepo,
        sessions,
      },
    };
  },
};
