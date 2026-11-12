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
    assertEquals((result.issues as Resource[])[0].nodeId, "I_1");
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

Deno.test("intake promotion commits a page only from its predecessor checkpoint", () => {
  const link = { stableId: "a.b.1", nodeId: "I_1", key: "mere-ops-pub-1" };
  const first = testing.decideIntakePromotion(null, {
    repo: "a/b",
    expectedAfter: null,
    nextAfter: "C1",
    emitted: ["I_1"],
    links: [link],
  });
  assertEquals(first.kind, "write");
  assertEquals((first as { state: Resource }).state.after, "C1");

  const stored = (first as { state: Resource }).state;
  const redelivery = testing.decideIntakePromotion(stored, {
    repo: "a/b",
    expectedAfter: null,
    nextAfter: "C1",
    emitted: ["I_1"],
    links: [link],
  });
  assertEquals(redelivery.kind, "noop");

  const second = testing.decideIntakePromotion(stored, {
    repo: "a/b",
    expectedAfter: "C1",
    nextAfter: "C2",
    emitted: ["I_2"],
    links: [{ stableId: "a.b.2", nodeId: "I_2", key: "mere-ops-pub-2" }],
  });
  assertEquals(second.kind, "write");
  assertEquals(
    ((second as { state: Resource }).state.links as unknown[]).length,
    2,
  );
});

Deno.test("intake promotion rejects an out-of-order page without regressing", () => {
  const stored = {
    repo: "a/b",
    after: "C2",
    emitted: [],
    links: [],
  };
  let thrown: unknown;
  try {
    testing.decideIntakePromotion(stored, {
      repo: "a/b",
      expectedAfter: null,
      nextAfter: "C1",
      emitted: ["I_1"],
      links: [],
    });
  } catch (error) {
    thrown = error;
  }
  assertExists(thrown);
  assertEquals(String(thrown).includes("checkpoint-conflict"), true);
});

Deno.test("intake promotion deduplicates links by immutable node ID", () => {
  const stored = {
    repo: "a/b",
    after: "C1",
    emitted: [],
    links: [{ stableId: "a.b.1", nodeId: "I_1", key: "old" }],
  };
  const decision = testing.decideIntakePromotion(stored, {
    repo: "a/b",
    expectedAfter: "C1",
    nextAfter: "C2",
    emitted: ["I_1"],
    links: [{ stableId: "a.b.1", nodeId: "I_1", key: "new" }],
  });
  const links = (decision as { state: Resource }).state.links as Resource[];
  assertEquals(links.length, 1);
  assertEquals(links[0].key, "new");
});

Deno.test("promote_intake returns a written handle when a page is redelivered", async () => {
  const stored = {
    repo: "a/b",
    after: "C1",
    emitted: ["I_1"],
    links: [{ stableId: "a.b.1", nodeId: "I_1", key: "k1" }],
  };
  const writes: { name: string; data: unknown }[] = [];
  const method = extension.methods.find((entry) =>
    "promote_intake" in entry
  ) as unknown as {
    promote_intake: {
      execute: (
        args: Resource,
        context: TestContext,
      ) => Promise<{ dataHandles: { name: string }[] }>;
    };
  };
  const result = await method.promote_intake.execute(
    {
      repo: "a/b",
      expectedAfter: null,
      nextAfter: "C1",
      emitted: ["I_1"],
      links: stored.links,
    },
    {
      readResource: () => Promise.resolve(stored),
      writeResource: (_spec, name, data) => {
        writes.push({ name, data });
        return Promise.resolve({ name });
      },
      logger: { warning: () => {} },
    },
  );
  assertEquals(writes.length, 1);
  assertEquals(writes[0].data, stored);
  assertEquals(result.dataHandles.length, 1);
});

Deno.test("intake check classifies fresh, committed and stale pages without writing", () => {
  const stored = { repo: "a/b", after: "C2", emitted: [], links: [] };
  assertEquals(
    testing.checkIntakePage(null, { expectedAfter: null, nextAfter: "C1" }),
    "fresh",
  );
  assertEquals(
    testing.checkIntakePage(stored, { expectedAfter: "C2", nextAfter: "C3" }),
    "fresh",
  );
  assertEquals(
    testing.checkIntakePage(stored, { expectedAfter: "C1", nextAfter: "C2" }),
    "committed",
  );
  let thrown: unknown;
  try {
    testing.checkIntakePage(stored, { expectedAfter: null, nextAfter: "C1" });
  } catch (error) {
    thrown = error;
  }
  assertExists(thrown);
  assertEquals(String(thrown).includes("checkpoint-conflict"), true);
});

Deno.test("check_intake writes its result under a fixed name", async () => {
  const writes: { spec: string; name: string; data: unknown }[] = [];
  const method = extension.methods.find((entry) =>
    "check_intake" in entry
  ) as unknown as {
    check_intake: {
      execute: (
        args: Resource,
        context: TestContext,
      ) => Promise<{ dataHandles: { name: string }[] }>;
    };
  };
  await method.check_intake.execute(
    { repo: "a/b", expectedAfter: null, nextAfter: "C1" },
    {
      readResource: () => Promise.resolve(null),
      writeResource: (spec, name, data) => {
        writes.push({ spec, name, data });
        return Promise.resolve({ name });
      },
      logger: { warning: () => {} },
    },
  );
  assertEquals(writes.length, 1);
  assertEquals(writes[0].spec, "intakeCheck");
  assertEquals(writes[0].name, "intake-check");
  assertEquals((writes[0].data as Resource).status, "fresh");
});

Deno.test("priority bands map triage facts and default to P3", () => {
  assertEquals(testing.computePriority({ securityConfirmed: true }), "P0");
  assertEquals(
    testing.computePriority({ releaseBlockingRegression: true }),
    "P0",
  );
  assertEquals(
    testing.computePriority({ supportedUserRegression: true }),
    "P1",
  );
  assertEquals(testing.computePriority({ requiredUpdate: true }), "P1");
  assertEquals(testing.computePriority({ reproducibleBug: true }), "P2");
  assertEquals(testing.computePriority({ acceptedMaintenance: true }), "P2");
  assertEquals(testing.computePriority({}), "P3");
  assertEquals(
    testing.computePriority({ securityConfirmed: true, reproducibleBug: true }),
    "P0",
  );
});

Deno.test("a recorded override wins over a later computed value", () => {
  const journal = [
    {
      item: "i1",
      by: "jeremy",
      reason: "urgent",
      from: "P2",
      to: "P0",
      at: "t1",
    },
  ] as never;
  assertEquals(testing.effectivePriority("P3", journal, "i1"), "P0");
  assertEquals(testing.effectivePriority("P1", journal, "i1"), "P0");
  assertEquals(testing.effectivePriority("P2", journal, "other"), "P2");
});

Deno.test("the latest override for an item wins", () => {
  const journal = [
    { item: "i1", by: "a", reason: "r", from: "P2", to: "P0", at: "t1" },
    { item: "i1", by: "b", reason: "r", from: "P0", to: "P3", at: "t2" },
  ] as never;
  assertEquals(testing.effectivePriority("P1", journal, "i1"), "P3");
});

Deno.test("pickNext orders by priority, then age, then stable ID", () => {
  const pick = testing.pickNext([
    { item: "a", stableId: "x.y.9", createdAt: "2026-01-01", priority: "P2" },
    { item: "b", stableId: "x.y.3", createdAt: "2026-01-03", priority: "P1" },
    { item: "c", stableId: "x.y.2", createdAt: "2026-01-02", priority: "P1" },
    { item: "d", stableId: "x.y.1", createdAt: "2026-01-02", priority: "P1" },
  ]);
  assertEquals(pick?.item, "d");
  assertEquals(testing.pickNext([]), null);
});

Deno.test("the WIP lease is acquired once and the epoch only rises", () => {
  const first = testing.decideAcquire(null, "item-a", "t1");
  assertEquals(first.epoch, 1);
  assertEquals(first.holder, "item-a");

  let thrown: unknown;
  try {
    testing.decideAcquire(first as never, "item-b", "t2");
  } catch (error) {
    thrown = error;
  }
  assertExists(thrown);
  assertEquals(String(thrown).includes("lease-held"), true);

  const released = testing.decideRelease(first as never, "item-a", 1, "done");
  assertEquals(released.epoch, 1);
  assertEquals(released.holder, null);

  const second = testing.decideAcquire(released as never, "item-b", "t3");
  assertEquals(second.epoch, 2);
  const third = testing.decideAcquire(
    testing.decideRelease(second as never, "item-b", 2, "done") as never,
    "item-a",
    "t4",
  );
  assertEquals(third.epoch, 3);
});

Deno.test("a stale or wrong holder cannot release the lease", () => {
  const lease = testing.decideAcquire(null, "item-a", "t1");
  for (const [holder, epoch] of [["item-a", 2], ["item-b", 1]] as const) {
    let thrown: unknown;
    try {
      testing.decideRelease(lease as never, holder, epoch, "x");
    } catch (error) {
      thrown = error;
    }
    assertExists(thrown);
    assertEquals(String(thrown).includes("lease-fenced"), true);
  }
});

Deno.test("a failed lease write leaves the epoch unchanged so it is never reused", async () => {
  const stored = { epoch: 4, holder: null, acquiredAt: null, reason: "done" };
  const method = extension.methods.find((entry) =>
    "acquire_lease" in entry
  ) as unknown as {
    acquire_lease: {
      execute: (
        args: Resource,
        context: TestContext,
      ) => Promise<{ dataHandles: { name: string }[] }>;
    };
  };
  let attempted: unknown;
  let thrown: unknown;
  try {
    await method.acquire_lease.execute({ holder: "item-a" }, {
      readResource: () => Promise.resolve(stored),
      writeResource: (_spec, _name, data) => {
        attempted = data;
        return Promise.reject(new Error("disk full"));
      },
      logger: { warning: () => {} },
    });
  } catch (error) {
    thrown = error;
  }
  assertExists(thrown);
  assertEquals((attempted as Resource).epoch, 5);
  // Nothing was stored, so the next acquire sees epoch 4 and offers 5 again.
  assertEquals(testing.decideAcquire(stored as never, "item-a", "t").epoch, 5);
});

Deno.test("resume needs the matching pause and restores the prior state", async () => {
  const id = await testing.pauseDigest(["i1", "jeremy", "why", "ready", "t0"]);
  const pause = {
    id,
    item: "i1",
    pausedBy: "jeremy",
    reason: "why",
    priorState: "ready",
    pausedAt: "t0",
  };
  const resumed = testing.decideResume(pause as never, id, "jeremy", "t1");
  assertEquals(resumed.restoredState, "ready");
  assertEquals(resumed.resumedBy, "jeremy");

  for (
    const call of [
      () => testing.decideResume(null, id, "jeremy", "t1"),
      () => testing.decideResume(pause as never, "other-pause", "jeremy", "t1"),
      () => testing.decideResume(pause as never, id, "", "t1"),
      () => testing.decideResume(resumed as never, id, "jeremy", "t2"),
    ]
  ) {
    let thrown: unknown;
    try {
      call();
    } catch (error) {
      thrown = error;
    }
    assertExists(thrown);
  }
});

Deno.test("an item paused from in-progress resumes as ready", () => {
  const pause = {
    id: "p1",
    item: "i1",
    pausedBy: "jeremy",
    reason: "why",
    priorState: "in-progress",
    pausedAt: "t0",
  };
  assertEquals(
    testing.decideResume(pause as never, "p1", "jeremy", "t1").restoredState,
    "ready",
  );
});

Deno.test("delivery units reject duplicates, unknown dependencies and cycles", () => {
  const unit = (id: string, dependencies: string[]) => ({
    id,
    repository: "a/b",
    baseRef: "main",
    allowedPaths: ["x"],
    workflow: "w",
    dependencies,
  });
  testing.validateDeliveryUnits([unit("a", []), unit("b", ["a"])]);
  for (
    const children of [
      [unit("a", []), unit("a", [])],
      [unit("a", ["missing"])],
      [unit("a", ["a"])],
      [unit("a", ["b"]), unit("b", ["a"])],
    ]
  ) {
    let thrown: unknown;
    try {
      testing.validateDeliveryUnits(children);
    } catch (error) {
      thrown = error;
    }
    assertExists(thrown);
  }
});

Deno.test("an override's old value comes from the journal, not the caller", () => {
  const first = testing.decideOverride([], {
    item: "i1",
    by: "jeremy",
    reason: "urgent",
    computed: "P2",
    to: "P0",
  }, "t1");
  assertEquals(first.from, "P2");
  assertEquals(first.to, "P0");

  const second = testing.decideOverride([first], {
    item: "i1",
    by: "jeremy",
    reason: "calmer",
    computed: "P2",
    to: "P3",
  }, "t2");
  assertEquals(second.from, "P0");

  let thrown: unknown;
  try {
    testing.decideOverride([first], {
      item: "i1",
      by: "jeremy",
      reason: "same",
      computed: "P2",
      to: "P0",
    }, "t3");
  } catch (error) {
    thrown = error;
  }
  assertExists(thrown);
  assertEquals(String(thrown).includes("override-noop"), true);
});

Deno.test("pausing the lease holder releases the lease and keeps the epoch", () => {
  const held = { epoch: 7, holder: "item-a", acquiredAt: "t", reason: null };
  const released = testing.releaseLeaseForPause(held, "item-a");
  assertExists(released);
  assertEquals(released!.holder, null);
  assertEquals(released!.epoch, 7);
  assertEquals(released!.reason, "interrupted: paused item-a");
  assertEquals(testing.releaseLeaseForPause(held, "item-b"), null);
  assertEquals(testing.releaseLeaseForPause(null, "item-a"), null);
});

Deno.test("pause_item writes the pause then releases the held lease, and a retry repairs a failed release", async () => {
  const method = extension.methods.find((entry) =>
    "pause_item" in entry
  ) as unknown as {
    pause_item: {
      execute: (
        args: Resource,
        context: TestContext,
      ) => Promise<{ dataHandles: { name: string }[] }>;
    };
  };
  const args = {
    item: "item-a",
    pausedBy: "jeremy",
    reason: "why",
    priorState: "in-progress",
  };
  const store = new Map<string, Resource>([
    ["wip-lease", {
      epoch: 3,
      holder: "item-a",
      acquiredAt: "t",
      reason: null,
    }],
  ]);
  let failLeaseWrite = true;
  const context: TestContext = {
    readResource: (name) => Promise.resolve(store.get(name) ?? null),
    writeResource: (_spec, name, data) => {
      if (name === "wip-lease" && failLeaseWrite) {
        return Promise.reject(new Error("disk full"));
      }
      store.set(name, data as Resource);
      return Promise.resolve({ name });
    },
    logger: { warning: () => {} },
  };

  let thrown: unknown;
  try {
    await method.pause_item.execute(args, context);
  } catch (error) {
    thrown = error;
  }
  assertExists(thrown);
  // The item is paused but the lease is still held: the WIP limit is kept.
  assertExists(store.get("pause-item-a"));
  assertEquals(store.get("wip-lease")!.holder, "item-a");

  const pauseId = store.get("pause-item-a")!.id;
  failLeaseWrite = false;
  await method.pause_item.execute(args, context);
  // The retry did not create a second pause and it released the lease.
  assertEquals(store.get("pause-item-a")!.id, pauseId);
  assertEquals(store.get("wip-lease")!.holder, null);
  assertEquals(store.get("wip-lease")!.epoch, 3);
});

const queueEntry = (
  item: string,
  stableId: string,
  createdAt: string,
  computed: string,
) => ({ item, stableId, createdAt, computed }) as never;

Deno.test("enqueue is idempotent and dequeue of an absent item changes nothing", () => {
  const a = queueEntry("a", "x.y.1", "2026-01-01", "P2");
  const queued = testing.decideEnqueue([], a)!;
  assertEquals(queued.length, 1);
  assertEquals(testing.decideEnqueue(queued, a), null);
  assertEquals(testing.decideDequeue(queued, "missing"), null);
  assertEquals(testing.decideDequeue(queued, "a")!.length, 0);
});

Deno.test("next_ready orders by priority, then age, then stable ID, and is empty-safe", () => {
  assertEquals(testing.nextReady([], []), null);
  const queue = [
    queueEntry("a", "x.y.9", "2026-01-01", "P2"),
    queueEntry("b", "x.y.3", "2026-01-03", "P1"),
    queueEntry("c", "x.y.2", "2026-01-02", "P1"),
    queueEntry("d", "x.y.1", "2026-01-02", "P1"),
  ];
  assertEquals(testing.nextReady(queue, [])!.entry.item, "d");
});

Deno.test("an override set after enqueue reorders the queue", () => {
  const queue = [
    queueEntry("a", "x.y.1", "2026-01-01", "P3"),
    queueEntry("b", "x.y.2", "2026-01-02", "P1"),
  ];
  assertEquals(testing.nextReady(queue, [])!.entry.item, "b");
  const journal = [
    { item: "a", by: "j", reason: "r", from: "P3", to: "P0", at: "t" },
  ] as never;
  const picked = testing.nextReady(queue, journal)!;
  assertEquals(picked.entry.item, "a");
  assertEquals(picked.priority, "P0");
});

Deno.test("a released or dequeued item is not returned again, and a resumed one is", () => {
  const a = queueEntry("a", "x.y.1", "2026-01-01", "P2");
  let queue = testing.decideEnqueue([], a)!;
  assertEquals(testing.nextReady(queue, [])!.entry.item, "a");
  // Scheduled: acquired, then dequeued.
  queue = testing.decideDequeue(queue, "a")!;
  assertEquals(testing.nextReady(queue, []), null);
  // Paused, then resumed as ready: the resume path enqueues it again.
  queue = testing.decideEnqueue(queue, a)!;
  assertEquals(testing.nextReady(queue, [])!.entry.item, "a");
});

Deno.test("next_ready and the queue methods use the declared resources and next_ready writes no queue", async () => {
  const find = (name: string) =>
    extension.methods.find((entry) => name in entry) as unknown as Record<
      string,
      {
        execute: (
          args: Resource,
          context: TestContext,
        ) => Promise<{ dataHandles: { name: string }[] }>;
      }
    >;
  const writes: { spec: string; name: string; data: unknown }[] = [];
  const store = new Map<string, Resource>();
  const context: TestContext = {
    readResource: (name) => Promise.resolve(store.get(name) ?? null),
    writeResource: (spec, name, data) => {
      writes.push({ spec, name, data });
      store.set(name, data as Resource);
      return Promise.resolve({ name });
    },
    logger: { warning: () => {} },
  };
  await find("enqueue_item").enqueue_item.execute({
    item: "a",
    stableId: "x.y.1",
    createdAt: "2026-01-01",
    facts: { reproducibleBug: true },
  }, context);
  assertEquals(writes[0].spec, "readyQueue");
  assertEquals(
    (store.get("ready-queue")!.entries as Resource[])[0].computed,
    "P2",
  );
  const before = writes.length;
  await find("next_ready").next_ready.execute({}, context);
  assertEquals(writes.length, before + 1);
  assertEquals(writes[before].spec, "nextReady");
  assertEquals((store.get("next-ready") as Resource).item, "a");
  assertEquals((store.get("ready-queue")!.entries as unknown[]).length, 1);
});

Deno.test("GitHub tracker exposes the Stagecraft contract", () => {
  assertEquals(extension.type, "@webframp/github");
  assertEquals(Object.keys(extension.resources).sort(), [
    "answer",
    "configuration",
    "deliveryUnits",
    "description",
    "githubRelations",
    "intakeCheck",
    "intakeState",
    "nextReady",
    "pauseRecord",
    "preflight",
    "priorityOverrides",
    "readyQueue",
    "wipLease",
  ]);
  assertEquals(
    extension.methods.flatMap((method) => Object.keys(method)).sort(),
    [
      "acquire_lease",
      "check_intake",
      "check_lease",
      "configure",
      "dequeue_item",
      "describe",
      "enqueue_item",
      "interrupt_lease",
      "next_ready",
      "operate",
      "pause_item",
      "preflight",
      "promote_intake",
      "release_lease",
      "resume_item",
      "set_delivery_units",
      "set_override",
    ],
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
