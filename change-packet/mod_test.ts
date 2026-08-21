import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  createPacket,
  CreatePacketSchema,
  model,
  PacketSchema,
  readinessOf,
  verifyPacket,
} from "./mod.ts";

const baseInput = {
  targetRepository: "github.com/example/project",
  sourceRepository: "github.com/example/project",
  base: { ref: "main", sha: "a".repeat(40) },
  head: { ref: "feature/change", sha: "b".repeat(40) },
  changedPaths: ["README.md", "src/main.ts"],
  checks: [{
    name: "unit-tests",
    required: true,
    outcome: "passed" as const,
    evidenceRef: "swamp-data://validation/unit-tests/1",
    detail: "",
  }],
  submission: {
    title: "docs: explain change packets",
    body: "Validated locally.",
    draft: true,
  },
};

Deno.test("createPacket produces a deterministic digest for equal semantic input", async () => {
  const options = {
    id: "11111111-1111-4111-8111-111111111111",
    createdAt: new Date("2026-08-18T00:00:00.000Z"),
  };
  const first = await createPacket(baseInput, options);
  const second = await createPacket(baseInput, options);

  assertEquals(first.payloadDigest, second.payloadDigest);
  assertEquals(
    first.payloadDigest,
    "f7acaf4508644cf13806b6c9336e82c48e36a88efa8b84510e5d7353664ed80b",
  );
  assertEquals(first.readiness, { ready: true, blockers: [] });
  assertEquals(first.head.sha, "b".repeat(40));
});

Deno.test("packet digest changes when submission content changes", async () => {
  const options = {
    id: "22222222-2222-4222-8222-222222222222",
    createdAt: new Date("2026-08-18T00:00:00.000Z"),
  };
  const first = await createPacket(baseInput, options);
  const changed = await createPacket({
    ...baseInput,
    submission: { ...baseInput.submission, body: "Different review context." },
  }, options);

  assertEquals(first.payloadDigest === changed.payloadDigest, false);
});

Deno.test("source repository is explicit and participates in the packet digest", async () => {
  const sameRepository = await createPacket(baseInput, {
    id: "55555555-5555-4555-8555-555555555555",
    createdAt: new Date("2026-08-18T00:00:00.000Z"),
  });
  const fork = await createPacket({
    ...baseInput,
    sourceRepository: "github.com/contributor/project",
  }, {
    id: "55555555-5555-4555-8555-555555555555",
    createdAt: new Date("2026-08-18T00:00:00.000Z"),
  });

  assertEquals(fork.sourceRepository, "github.com/contributor/project");
  assertEquals(fork.targetRepository, "github.com/example/project");
  assertEquals(fork.payloadDigest === sameRepository.payloadDigest, false);
});

Deno.test("verifyPacket accepts an untampered packet", async () => {
  const packet = await createPacket(baseInput, {
    id: "33333333-3333-4333-8333-333333333333",
    createdAt: new Date("2026-08-18T00:00:00.000Z"),
  });
  const verification = await verifyPacket(packet);

  assertEquals(verification.valid, true);
  assertEquals(verification.mismatches, []);
  assertEquals(verification.expectedDigest, packet.payloadDigest);
});

Deno.test("verifyPacket detects payload and derived-readiness tampering", async () => {
  const packet = await createPacket(baseInput, {
    id: "44444444-4444-4444-8444-444444444444",
    createdAt: new Date("2026-08-18T00:00:00.000Z"),
  });
  const tampered = {
    ...packet,
    submission: { ...packet.submission, title: "different title" },
    readiness: { ready: false, blockers: ["invented"] },
  };
  const verification = await verifyPacket(tampered);

  assertEquals(verification.valid, false);
  assertEquals(verification.mismatches, [
    "payloadDigest",
    "readiness.ready",
    "readiness.blockers",
  ]);
});

Deno.test("required failed, skipped, and unavailable checks block readiness", () => {
  assertEquals(
    readinessOf([
      { ...baseInput.checks[0], outcome: "failed", detail: "test failure" },
      {
        ...baseInput.checks[0],
        name: "lint",
        outcome: "skipped",
        detail: "not installed",
      },
      {
        ...baseInput.checks[0],
        name: "integration",
        outcome: "unavailable",
        detail: "runner down",
      },
    ]),
    {
      ready: false,
      blockers: [
        "unit-tests: failed",
        "lint: skipped",
        "integration: unavailable",
      ],
    },
  );
});

Deno.test("optional non-passing checks are retained but do not block readiness", () => {
  assertEquals(
    readinessOf([
      {
        ...baseInput.checks[0],
        required: false,
        outcome: "unavailable",
        detail: "optional service down",
      },
      baseInput.checks[0],
    ]),
    { ready: true, blockers: [] },
  );
});

Deno.test("packet input rejects ambiguous or unsafe change identity", () => {
  assertThrows(
    () => CreatePacketSchema.parse({ ...baseInput, head: baseInput.base }),
    Error,
    "must differ from the base ref",
  );
  assertThrows(
    () =>
      CreatePacketSchema.parse({ ...baseInput, changedPaths: ["../secret"] }),
    Error,
    "repository-relative path",
  );
  assertThrows(
    () =>
      CreatePacketSchema.parse({
        ...baseInput,
        checks: [baseInput.checks[0], baseInput.checks[0]],
      }),
    Error,
    "must be unique",
  );
});

Deno.test("non-passing checks require an explicit explanation", () => {
  assertThrows(
    () =>
      CreatePacketSchema.parse({
        ...baseInput,
        checks: [{ ...baseInput.checks[0], outcome: "skipped" }],
      }),
    Error,
    "is required when a check did not pass",
  );
});

Deno.test("model methods write packet and verification resources", async () => {
  const writes: Array<{ spec: string; instance: string; data: unknown }> = [];
  const context = {
    writeResource: (spec: string, instance: string, data: unknown) => {
      writes.push({ spec, instance, data });
      return Promise.resolve({ name: instance });
    },
  };

  const createResult = await model.methods.create.execute(baseInput, context);
  assertEquals(createResult.dataHandles.length, 1);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].spec, "packet");
  assertEquals(writes[0].instance.startsWith("packet-"), true);

  const packet = PacketSchema.parse(writes[0].data);
  const verifyResult = await model.methods.verify.execute({ packet }, context);
  assertEquals(verifyResult.dataHandles.length, 1);
  assertEquals(writes.length, 2);
  assertEquals(writes[1].spec, "verification");
  assertEquals(writes[1].instance, `verification-${packet.id}`);
  assertEquals(writes[1].instance === writes[0].instance, false);
  assertEquals((writes[1].data as { valid: boolean }).valid, true);
});

Deno.test("verifyPacket rejects malformed untrusted packets", async () => {
  await assertRejects(
    () => verifyPacket({ ...baseInput, id: "not-a-packet" }),
    Error,
  );
});
