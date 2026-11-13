import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { report } from "./upstream_drift.ts";

type Handle = { name: string; version: number; specName: string };

function context(
  steps: Array<{
    methodName: string;
    status: string;
    handles: Array<{ spec: string; name: string; data: unknown }>;
  }>,
) {
  const store = new Map<string, unknown>();
  const stepExecutions = steps.map((step, index) => ({
    methodName: step.methodName,
    status: step.status,
    modelType: "@jeremy/mere-dev/source",
    modelId: `m${index}`,
    dataHandles: step.handles.map((h): Handle => {
      store.set(`m${index}/${h.name}`, h.data);
      return { name: h.name, version: 1, specName: h.spec };
    }),
  }));
  return {
    stepExecutions,
    dataRepository: {
      getContent: (_type: string, id: string, name: string) => {
        const value = store.get(`${id}/${name}`);
        return Promise.resolve(
          value === undefined
            ? null
            : new TextEncoder().encode(JSON.stringify(value)),
        );
      },
    },
  };
}

const upstream = (name: string, current: string, latest?: string) => ({
  name,
  currentVersion: current,
  ...(latest ? { latestVersion: latest, bumpKind: "minor" } : {}),
  isNewer: latest !== undefined && latest !== current,
  provider: latest ? "github" : "none",
  ...(latest ? {} : { note: "no provider matched" }),
});

Deno.test("the drift report lists recipes behind upstream and those it could not check", async () => {
  const result = await report.execute(context([
    {
      methodName: "scan",
      status: "succeeded",
      handles: [{
        spec: "scan",
        name: "scan",
        data: {
          commit: "0123456789abcdef",
          failures: [],
          normalized: [],
          hardcodedVersion: [],
        },
      }],
    },
    {
      methodName: "scanLatest",
      status: "succeeded",
      handles: [
        {
          spec: "upstream",
          name: "u-curl",
          data: upstream("curl", "8.1.0", "8.2.0"),
        },
        {
          spec: "upstream",
          name: "u-zlib",
          data: upstream("zlib", "1.3.0", "1.3.0"),
        },
        { spec: "upstream", name: "u-bash", data: upstream("bash", "5.2") },
      ],
    },
  ]));
  assertEquals(result.json.total, 3);
  assertEquals(result.json.behind.map((r: { name: string }) => r.name), [
    "curl",
  ]);
  assertEquals(result.json.current, 1);
  assertEquals(
    result.json.unresolved.map((r: { name: string }) => r.name),
    ["bash"],
  );
  assertStringIncludes(result.markdown, "curl");
});

Deno.test("the drift report ignores steps that did not succeed", async () => {
  const result = await report.execute(context([
    {
      methodName: "scanLatest",
      status: "failed",
      handles: [
        {
          spec: "upstream",
          name: "u-curl",
          data: upstream("curl", "8.1.0", "8.2.0"),
        },
      ],
    },
  ]));
  assertEquals(result.json.total, 0);
  assertEquals(result.json.behind, []);
});

Deno.test("the drift report skips handles whose content is missing", async () => {
  const ctx = context([{
    methodName: "scanLatest",
    status: "succeeded",
    handles: [{ spec: "upstream", name: "u-x", data: undefined }],
  }]);
  const result = await report.execute(ctx);
  assertEquals(result.json.total, 0);
});
