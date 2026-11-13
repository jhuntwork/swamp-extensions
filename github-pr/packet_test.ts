import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { createPacket } from "./test_packet.ts";
import { requirePacket, requirePacketOrChange } from "./packet.ts";

const input = {
  targetRepository: "github.com/example/project",
  sourceRepository: "github.com/example/project",
  base: { ref: "main", sha: "a".repeat(40) },
  head: { ref: "feature/change", sha: "b".repeat(40) },
  changedPaths: ["README.md"],
  checks: [{
    name: "test",
    required: true,
    outcome: "passed" as const,
    evidenceRef: "evidence://test",
    detail: "",
  }],
  submission: {
    title: "test",
    body: "Explain the example change.",
    draft: false,
  },
};

Deno.test("adapter computes integrity and readiness for slim change facts", async () => {
  const change = { ...input, schemaVersion: 1 as const };
  const packet = await requirePacketOrChange(change);
  assertEquals(packet.schemaVersion, 1);
  assertEquals(packet.readiness, { ready: true, blockers: [] });
  assertEquals(packet.submission.title, input.submission.title);
});
Deno.test("adapter accepts a genuine protocol-v1 packet and rejects tampering", async () => {
  const packet = await createPacket(input);
  await requirePacket(packet);
  await assertRejects(
    () =>
      requirePacket({
        ...packet,
        submission: { ...packet.submission, title: "tampered" },
      }),
    Error,
    "digest",
  );
});

// Draft is carried, not required: both states are legitimate requests, unlike
// the draft-only predecessor which rejected submission.draft === false.
Deno.test("adapter accepts both draft and non-draft submissions", async () => {
  const ordinary = await createPacket(input);
  assertEquals((await requirePacket(ordinary)).submission.draft, false);

  const draft = await createPacket({
    ...input,
    submission: { ...input.submission, draft: true },
  });
  assertEquals((await requirePacket(draft)).submission.draft, true);
});

Deno.test("adapter rejects process and formatting boilerplate in descriptions", async () => {
  await assertRejects(
    () =>
      requirePacketOrChange({
        ...input,
        schemaVersion: 1 as const,
        submission: {
          ...input.submission,
          body: "Built and validated locally.\n\nSee the pipeline.",
        },
      }),
    Error,
    "PR description policy",
  );
});

Deno.test("adapter independently enforces packet identity and check invariants", async () => {
  const packet = await createPacket(input);

  await assertRejects(
    () =>
      requirePacket({
        ...packet,
        changedPaths: ["../secret"],
      }),
    Error,
    "repository-relative path",
  );
  await assertRejects(
    () =>
      requirePacket({
        ...packet,
        base: { ...packet.base, ref: packet.head.ref },
      }),
    Error,
    "must differ from the base ref",
  );
  await assertRejects(
    () =>
      requirePacket({
        ...packet,
        checks: [packet.checks[0], packet.checks[0]],
      }),
    Error,
    "must be unique",
  );
  await assertRejects(
    () =>
      requirePacket({
        ...packet,
        checks: [{ ...packet.checks[0], outcome: "skipped", detail: "" }],
      }),
    Error,
    "is required when a check did not pass",
  );
});

Deno.test("adapter recomputes derived readiness instead of trusting the packet", async () => {
  const blocked = await createPacket({
    ...input,
    checks: [{ ...input.checks[0], outcome: "failed", detail: "test failed" }],
  });

  await assertRejects(
    () =>
      requirePacket({
        ...blocked,
        readiness: { ready: true, blockers: [] },
      }),
    Error,
    "derived readiness",
  );
});
