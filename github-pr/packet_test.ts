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

Deno.test("adapter preserves arbitrary commit body content", async () => {
  const bodies = [
    "Built and validated locally.\n\nSee the pipeline.",
    "# Heading\n\n- a list",
    "",
    "x".repeat(4_001),
  ];
  for (const body of bodies) {
    const result = await requirePacketOrChange({
      ...input,
      schemaVersion: 1 as const,
      submission: { ...input.submission, body },
    });
    assertEquals(result.submission.body, body);
  }
});

Deno.test("none and optional policies accept empty packet descriptions", async () => {
  for (const descriptionPolicy of ["none", "optional"] as const) {
    const packet = await requirePacketOrChange({
      ...input,
      schemaVersion: 1 as const,
      submission: {
        ...input.submission,
        body: "",
        descriptionPolicy,
      },
    });
    assertEquals(packet.submission.body, "");
    assertEquals(packet.submission.descriptionPolicy, descriptionPolicy);
  }
});

Deno.test("none policy rejects context and nonempty bodies", async () => {
  await assertRejects(
    () =>
      requirePacketOrChange({
        ...input,
        schemaVersion: 1 as const,
        submission: {
          ...input.submission,
          body: "Release details.",
          descriptionPolicy: "none" as const,
        },
      }),
    Error,
    "requires an empty description",
  );
  await assertRejects(
    () =>
      requirePacketOrChange({
        ...input,
        schemaVersion: 1 as const,
        submission: {
          ...input.submission,
          body: "",
          descriptionPolicy: "none" as const,
          maintainerContext: {
            kind: "upstream" as const,
            summary: "Release details.",
          },
        },
      }),
    Error,
    "does not accept maintainer context",
  );
});
Deno.test("maintainer policy requires context and carries it through the packet", async () => {
  const context = {
    kind: "change" as const,
    problem: "GPU discovery cannot see the device sysfs tree.",
    rationale: "Expose sysfs only in interactive shells with a read-only bind.",
  };
  const accepted = await requirePacketOrChange({
    ...input,
    schemaVersion: 1 as const,
    submission: {
      ...input.submission,
      body:
        "GPU discovery cannot see the device sysfs tree. Expose sysfs only in interactive shells with a read-only bind.",
      descriptionPolicy: "maintainer" as const,
      maintainerContext: context,
    },
  });
  assertEquals(accepted.submission.maintainerContext, context);
  await assertRejects(
    () =>
      requirePacketOrChange({
        ...input,
        schemaVersion: 1 as const,
        submission: {
          ...input.submission,
          descriptionPolicy: "maintainer" as const,
        },
      }),
    Error,
    "maintainer context is required",
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

Deno.test("adapter preserves body formatting regardless of description style", async () => {
  const bodies = [
    "5.8.4:\n\n- Fix one.\n- Fix two.\n\nSee upstream.",
    "# Heading\n\ntext",
    "text\n```\ncode\n```",
    "Tests pass.",
  ];
  for (const body of bodies) {
    const result = await requirePacketOrChange({
      ...input,
      schemaVersion: 1 as const,
      submission: {
        ...input.submission,
        body,
        descriptionStyle: "markdown" as const,
      },
    });
    assertEquals(result.submission.body, body);
  }
});
