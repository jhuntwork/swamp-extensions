import { assertEquals, assertExists } from "jsr:@std/assert@1.0.19";
import { extension } from "./github_tracker.ts";

type Resource = Record<string, unknown>;
type TestContext = {
  readResource: (name: string) => Promise<Resource | null>;
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: { warning: (message: string, properties?: Resource) => void };
};
type OperateExecute = (
  args: Resource,
  context: TestContext,
) => Promise<{ dataHandles?: { name: string }[] }>;

function operateExecute(): OperateExecute {
  const method = extension.methods.find((entry) => "operate" in entry) as {
    operate: { execute: OperateExecute };
  } | undefined;
  assertExists(method);
  return method.operate.execute;
}

Deno.test("GitHub tracker exposes the Stagecraft contract", () => {
  assertEquals(extension.type, "@webframp/github");
  assertEquals(Object.keys(extension.resources).sort(), [
    "answer",
    "configuration",
    "description",
    "githubRelations",
    "preflight",
  ]);
  assertEquals(
    extension.methods.flatMap((method) => Object.keys(method)).sort(),
    ["configure", "describe", "operate", "preflight"],
  );
});

Deno.test("operate is idempotent when an answer already exists", async () => {
  const existing: Resource = {
    operation: "fetch_issue",
    run: "run-1",
    ok: true,
    result: { id: "acme.repo.1" },
  };
  const writes: unknown[] = [];
  const result = await operateExecute()(
    {
      operation: "fetch_issue",
      request: "{}",
      answer: "answer-1",
      run: "run-1",
    },
    {
      readResource: () => Promise.resolve(existing),
      writeResource: (_spec, name, data) => {
        writes.push({ name, data });
        return Promise.resolve({ name });
      },
      logger: { warning: () => {} },
    },
  );

  assertEquals(result.dataHandles, [{ name: "answer-1" }]);
  assertEquals(writes, [{ name: "answer-1", data: existing }]);
});

Deno.test("operate records invalid requests without throwing", async () => {
  let written: Resource | undefined;
  const result = await operateExecute()(
    {
      operation: "fetch_issue",
      request: "{}",
      answer: "answer-2",
      run: "run-2",
    },
    {
      readResource: () => Promise.resolve(null),
      writeResource: (_spec, name, data) => {
        written = data as Resource;
        return Promise.resolve({ name });
      },
      logger: { warning: () => {} },
    },
  );

  assertEquals(result.dataHandles, [{ name: "answer-2" }]);
  assertEquals(written?.operation, "fetch_issue");
  assertEquals(written?.run, "run-2");
  assertEquals(written?.ok, false);
  assertEquals(typeof written?.detail, "string");
});
