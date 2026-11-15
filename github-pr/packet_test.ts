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
  const packet = await requirePacketOrChange({ ...input, schemaVersion: 1 as const });
  assertEquals(packet.schemaVersion, 1);
  assertEquals(packet.readiness, { ready: true, blockers: [] });
});

Deno.test("adapter accepts a genuine packet and rejects tampering", async () => {
  const packet = await createPacket(input);
  await requirePacket(packet);
  await assertRejects(
    () => requirePacket({ ...packet, submission: { ...packet.submission, title: "tampered" } }),
    Error,
    "digest",
  );
});

Deno.test("adapter preserves every supplied body, including empty and long bodies", async () => {
  const bodies = [
    "",
    "# Heading\n\n- a list\n\ntext",
    "text\n```\ncode\n```",
    "x".repeat(4_001),
    "first\n\nsecond\n\nthird",
  ];
  for (const body of bodies) {
    const packet = await requirePacketOrChange({
      ...input,
      schemaVersion: 1 as const,
      submission: { ...input.submission, body },
    });
    assertEquals(packet.submission.body, body);
  }
});

Deno.test("adapter accepts both draft and non-draft submissions", async () => {
  const ordinary = await createPacket(input);
  assertEquals((await requirePacket(ordinary)).submission.draft, false);
  const draft = await createPacket({
    ...input,
    submission: { ...input.submission, draft: true },
  });
  assertEquals((await requirePacket(draft)).submission.draft, true);
});

Deno.test("adapter enforces packet identity and check invariants", async () => {
  const packet = await createPacket(input);
  await assertRejects(
    () => requirePacket({ ...packet, changedPaths: ["../secret"] }),
    Error,
    "repository-relative path",
  );
  await assertRejects(
    () => requirePacket({ ...packet, base: { ...packet.base, ref: packet.head.ref } }),
    Error,
    "must differ from the base ref",
  );
  await assertRejects(
    () => requirePacket({ ...packet, checks: [packet.checks[0], packet.checks[0]] }),
    Error,
    "must be unique",
  );
});
