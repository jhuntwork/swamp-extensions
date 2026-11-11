import { assertEquals, assertExists } from "jsr:@std/assert@1.0.19";
import { extension, testing } from "./github_tracker.ts";

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

Deno.test("status projection accepts only canonical state-label pairs", () => {
  assertEquals(
    testing.statusName({ state: "OPEN", labels: [] } as never),
    "open",
  );
  assertEquals(
    testing.statusName(
      { state: "OPEN", labels: [{ name: "status:in-progress" }] } as never,
    ),
    "status:in-progress",
  );
  assertEquals(
    testing.statusName(
      { state: "CLOSED", labels: [{ name: "status:done" }] } as never,
    ),
    "status:done",
  );
  assertEquals(
    testing.statusName({ state: "CLOSED", labels: [] } as never),
    "closed",
  );
});

Deno.test("status projection rejects conflicting or mismatched owned labels", () => {
  for (
    const issue of [
      { state: "OPEN", labels: [{ name: "status:done" }] },
      { state: "CLOSED", labels: [{ name: "status:in-progress" }] },
      {
        state: "OPEN",
        labels: [{ name: "status:in-progress" }, { name: "status:done" }],
      },
    ]
  ) {
    let thrown: unknown;
    try {
      testing.statusName(issue as never);
    } catch (error) {
      thrown = error;
    }
    assertExists(thrown);
  }
});

Deno.test("enumerate_issues uses both states and returns a final-page checkpoint", async () => {
  const calls: string[][] = [];
  testing.setGhForTest((args) => {
    calls.push(args);
    return Promise.resolve({
      data: {
        repository: {
          issues: {
            nodes: [{
              id: "I_1",
              number: 1,
              title: "closed issue",
              body: "",
              state: "CLOSED",
              url: "https://example.test/issues/1",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-02T00:00:00Z",
              labels: { nodes: [{ name: "status:done" }] },
            }],
            pageInfo: { endCursor: "opaque-final", hasNextPage: false },
          },
        },
      },
    });
  });
  try {
    const writes: Resource[] = [];
    await operateExecute()(
      {
        operation: "enumerate_issues",
        request: JSON.stringify({ repo: "acme/repo", limit: 2 }),
        answer: "enumerate-answer",
        run: "run-enumerate",
      },
      {
        readResource: () => Promise.resolve(null),
        writeResource: (_spec, _name, data) => {
          writes.push(data as Resource);
          return Promise.resolve({ name: "enumerate-answer" });
        },
        logger: { warning: () => {} },
      },
    );
    assertEquals(calls.length, 1);
    assertEquals(calls[0].includes("graphql"), true);
    assertEquals(
      calls[0].some((value) => value.includes("states: [OPEN, CLOSED]")),
      true,
    );
    const result = writes[0].result as Resource;
    assertEquals((result.checkpoint as Resource).after, "opaque-final");
    assertEquals((result.checkpoint as Resource).exhausted, true);
    assertEquals(
      ((result.issues as Resource[])[0].status as Resource).id,
      "status:done",
    );
  } finally {
    testing.resetGhForTest();
  }
});

Deno.test("set_status changes GitHub state before adding its owned label", async () => {
  const calls: string[][] = [];
  testing.setGhForTest((args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve({
        number: 1,
        title: "issue",
        body: "",
        state: "OPEN",
        labels: [],
        url: "https://example.test/issues/1",
      });
    }
    return Promise.resolve(null);
  });
  try {
    await operateExecute()(
      {
        operation: "set_status",
        request: JSON.stringify({
          repo: "acme/repo",
          issue: 1,
          status: "status:done",
        }),
        answer: "status-answer",
        run: "run-status",
      },
      {
        readResource: () => Promise.resolve(null),
        writeResource: () => Promise.resolve({ name: "status-answer" }),
        logger: { warning: () => {} },
      },
    );
    const close = calls.findIndex((args) =>
      args[0] === "issue" && args[1] === "close"
    );
    const add = calls.findIndex((args) => args.includes("--add-label"));
    assertEquals(close >= 0 && add > close, true);
  } finally {
    testing.resetGhForTest();
  }
});

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

Deno.test("operate retries a failed answer instead of treating it as a receipt", async () => {
  const failed: Resource = {
    operation: "fetch_issue",
    run: "run-1",
    ok: false,
    kind: "upstream",
    result: null,
  };
  const writes: unknown[] = [];
  await operateExecute()(
    {
      operation: "fetch_issue",
      request: "{}",
      answer: "answer-retry",
      run: "run-2",
    },
    {
      readResource: () => Promise.resolve(failed),
      writeResource: (_spec, name, data) => {
        writes.push({ name, data });
        return Promise.resolve({ name });
      },
      logger: { warning: () => {} },
    },
  );

  assertEquals(writes.length, 1);
  assertEquals((writes[0] as Resource).name, "answer-retry");
  assertEquals(((writes[0] as Resource).data as Resource).run, "run-2");
  assertEquals(((writes[0] as Resource).data as Resource).ok, false);
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
