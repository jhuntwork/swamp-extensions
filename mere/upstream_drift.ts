import {
  driftMarkdown,
  type ScanSummary,
  summarizeDrift,
  type UpstreamRecord,
} from "./models/_lib/drift.ts";

interface Handle {
  name: string;
  version: number;
  specName: string;
}

interface Step {
  methodName: string;
  status: string;
  modelType: string;
  modelId: string;
  dataHandles: Handle[];
}

interface Context {
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

export const report = {
  name: "@jeremy/mere/upstream-drift",
  description:
    "Which merelinux recipes are behind upstream, which could not be checked, and why.",
  scope: "workflow",
  labels: ["mere", "drift"],
  execute: async (context: Context) => {
    const read = async (step: Step, handle: Handle) => {
      const bytes = await context.dataRepository.getContent(
        step.modelType,
        step.modelId,
        handle.name,
        handle.version,
      );
      return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : undefined;
    };
    const records: UpstreamRecord[] = [];
    let scan: ScanSummary | undefined;
    for (const step of context.stepExecutions) {
      if (step.status !== "succeeded") continue;
      for (const handle of step.dataHandles) {
        if (
          step.methodName === "scanLatest" && handle.specName === "upstream"
        ) {
          const data = await read(step, handle);
          if (data) records.push(data);
        } else if (step.methodName === "scan" && handle.specName === "scan") {
          scan = await read(step, handle);
        }
      }
    }
    const drift = summarizeDrift(records, scan);
    return {
      markdown: driftMarkdown(drift),
      json: {
        total: drift.total,
        behind: drift.behind.map((r) => ({
          name: r.name,
          current: r.currentVersion,
          latest: r.latestVersion,
          latestInSeries: r.latestInSeries,
          kind: r.bumpKind,
          provider: r.provider,
          candidateUrl: r.candidateUrl,
        })),
        current: drift.current,
        unresolved: drift.unresolved.map((r) => ({
          name: r.name,
          current: r.currentVersion,
          note: r.note,
        })),
        byProvider: drift.byProvider,
        scan: drift.scan,
      },
    };
  },
};
