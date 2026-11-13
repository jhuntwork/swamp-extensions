import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./build_summary.ts";

Deno.test("build-summary includes passed and failed build evidence", async () => {
  const records = new Map([
    [
      "build-good",
      {
        recipe: "core/zlib-ng",
        name: "zlib-ng",
        version: "2.2.4",
        release: 1,
        arch: "x86_64",
        ok: true,
        exitCode: 0,
        durationMs: 1200,
        failingPhase: "",
        errorLine: "",
        outputs: [{
          fileName: "zlib-ng.pkg.tar.zst",
          package: "zlib-ng",
          sha256: "a".repeat(64),
          bytes: 42,
        }],
      },
    ],
    [
      "build-bad",
      {
        recipe: "extra/broken",
        name: "broken",
        version: "1.0.0",
        release: 1,
        arch: "x86_64",
        ok: false,
        exitCode: 1,
        durationMs: 300,
        failingPhase: "compile",
        errorLine: "compile failed | missing header",
        outputs: [],
      },
    ],
  ]);
  const result = await report.execute({
    stepExecutions: [
      {
        methodName: "build",
        status: "succeeded",
        modelType: "@jeremy/mere/recipe",
        modelId: "merelinux",
        dataHandles: [{ name: "build-good", version: 1, specName: "build" }],
      },
      {
        methodName: "build",
        status: "failed",
        modelType: "@jeremy/mere/recipe",
        modelId: "merelinux",
        dataHandles: [{ name: "build-bad", version: 1, specName: "build" }],
      },
    ],
    dataRepository: {
      getContent: (_type, _modelId, name) => {
        const record = records.get(name);
        return Promise.resolve(
          record ? new TextEncoder().encode(JSON.stringify(record)) : null,
        );
      },
    },
  });

  assertEquals(result.json.total, 2);
  assertEquals(result.json.passed, 1);
  assertEquals(result.json.failed, 1);
  assertEquals(result.json.packages, 1);
  assertStringIncludes(result.markdown, "core/zlib-ng");
  assertStringIncludes(result.markdown, "failed (compile)");
  assertStringIncludes(result.markdown, "missing header");
});

Deno.test("build-summary remains readable when no builds ran", async () => {
  const result = await report.execute({
    stepExecutions: [],
    dataRepository: {
      getContent: () => Promise.resolve(null),
    },
  });

  assertEquals(result.json, {
    total: 0,
    passed: 0,
    failed: 0,
    packages: 0,
    builds: [],
  });
  assertStringIncludes(result.markdown, "Builds: 0");
});
