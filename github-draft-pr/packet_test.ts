import { assertRejects } from "jsr:@std/assert@1.0.19";
import { createPacket } from "../change-packet/mod.ts";
import { requireDraftPacket } from "./packet.ts";

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
  submission: { title: "test", body: "", draft: true },
};

Deno.test("adapter accepts a genuine protocol-v1 packet and rejects tampering", async () => {
  const packet = await createPacket(input);
  await requireDraftPacket(packet);
  await assertRejects(
    () =>
      requireDraftPacket({
        ...packet,
        submission: { ...packet.submission, title: "tampered" },
      }),
    Error,
    "digest",
  );
});

Deno.test("adapter independently enforces packet identity and check invariants", async () => {
  const packet = await createPacket(input);

  await assertRejects(
    () =>
      requireDraftPacket({
        ...packet,
        changedPaths: ["../secret"],
      }),
    Error,
    "repository-relative path",
  );
  await assertRejects(
    () =>
      requireDraftPacket({
        ...packet,
        base: { ...packet.base, ref: packet.head.ref },
      }),
    Error,
    "must differ from the base ref",
  );
  await assertRejects(
    () =>
      requireDraftPacket({
        ...packet,
        checks: [packet.checks[0], packet.checks[0]],
      }),
    Error,
    "must be unique",
  );
  await assertRejects(
    () =>
      requireDraftPacket({
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
      requireDraftPacket({
        ...blocked,
        readiness: { ready: true, blockers: [] },
      }),
    Error,
    "derived readiness",
  );
});
