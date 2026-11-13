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

interface BuildOutput {
  fileName: string;
  package: string;
  sha256: string;
  bytes: number;
}

interface BuildRecord {
  recipe: string;
  name: string;
  version: string;
  release: number;
  arch: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  failingPhase: string;
  errorLine: string;
  outputs: BuildOutput[];
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

function markdown(records: BuildRecord[]): string {
  const passed = records.filter((record) => record.ok).length;
  const failed = records.length - passed;
  const packages = records.reduce(
    (total, record) => total + record.outputs.length,
    0,
  );
  const lines = [
    "# Build summary",
    "",
    `Builds: ${records.length}. Passed: ${passed}. Failed: ${failed}. Packages: ${packages}.`,
    "",
    "| Recipe | Version | Arch | Result | Packages | Duration |",
    "| --- | --- | --- | --- | ---: | ---: |",
  ];
  for (const record of records) {
    const result = record.ok
      ? "passed"
      : `failed${record.failingPhase ? ` (${record.failingPhase})` : ""}`;
    lines.push(
      `| ${record.recipe} | ${record.version}-${record.release} | ${record.arch} | ${result} | ${record.outputs.length} | ${record.durationMs} ms |`,
    );
    if (!record.ok && record.errorLine) {
      lines.push(
        `|  |  |  | ${record.errorLine.replaceAll("|", "\\|")} |  |  |`,
      );
    }
  }
  return lines.join("\n");
}

/** Workflow report summarizing recipe build outcomes and produced packages. */
export const report = {
  name: "@jeremy/mere-dev/build-summary",
  description:
    "Summarize recipe build results, package outputs, durations, and failures recorded by a workflow.",
  scope: "workflow",
  labels: ["mere", "build"],
  execute: async (context: Context) => {
    const records: BuildRecord[] = [];
    for (const step of context.stepExecutions) {
      for (const handle of step.dataHandles ?? []) {
        if (step.methodName !== "build" || handle.specName !== "build") {
          continue;
        }
        const bytes = await context.dataRepository.getContent(
          step.modelType,
          step.modelId,
          handle.name,
          handle.version,
        );
        if (!bytes) continue;
        const value = JSON.parse(
          new TextDecoder().decode(bytes),
        ) as BuildRecord;
        records.push({
          recipe: value.recipe,
          name: value.name,
          version: value.version,
          release: value.release,
          arch: value.arch,
          ok: value.ok,
          exitCode: value.exitCode,
          durationMs: value.durationMs,
          failingPhase: value.failingPhase,
          errorLine: value.errorLine,
          outputs: value.outputs.map((output) => ({
            fileName: output.fileName,
            package: output.package,
            sha256: output.sha256,
            bytes: output.bytes,
          })),
        });
      }
    }
    records.sort((a, b) => a.recipe.localeCompare(b.recipe));
    const passed = records.filter((record) => record.ok).length;
    return {
      markdown: markdown(records),
      json: {
        total: records.length,
        passed,
        failed: records.length - passed,
        packages: records.reduce(
          (total, record) => total + record.outputs.length,
          0,
        ),
        builds: records,
      },
    };
  },
};
