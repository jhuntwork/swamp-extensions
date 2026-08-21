// ABOUTME: Forge-neutral, immutable change-packet model for reviewed delivery workflows.
// ABOUTME: Records validated Git change identity and requested draft-submission metadata without remote mutation.

import { z } from "npm:zod@4.4.3";

const PacketSchemaVersion = 1;

const GitShaSchema = z.string()
  .regex(/^[0-9a-fA-F]{40,64}$/, "must be a full hexadecimal Git object ID")
  .transform((value) => value.toLowerCase());

const GitRefSchema = z.string()
  .min(1)
  .max(512)
  .refine((value) => !/\s/.test(value), "must not contain whitespace");

const RelativePathSchema = z.string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.split("/").some((segment) =>
        segment === "" || segment === "." || segment === ".."
      ),
    "must be a normalized, repository-relative path",
  );

const RevisionSchema = z.object({
  ref: GitRefSchema.describe("Named Git ref, such as main or feature/example"),
  sha: GitShaSchema.describe("Full commit object ID resolved for the ref"),
});

const CheckSchema = z.object({
  name: z.string().min(1).max(256).describe(
    "Stable name of the validation check",
  ),
  required: z.boolean().default(true).describe(
    "Whether this check must pass before the packet is ready for submission",
  ),
  outcome: z.enum(["passed", "failed", "skipped", "unavailable"]),
  evidenceRef: z.string().min(1).max(2048).describe(
    "Opaque durable reference to the validation evidence or its explicit gap record",
  ),
  detail: z.string().max(4096).default("").describe(
    "Concise result or reason a check did not run",
  ),
}).superRefine((check, context) => {
  if (check.outcome !== "passed" && check.detail.trim() === "") {
    context.addIssue({
      code: "custom",
      path: ["detail"],
      message: "is required when a check did not pass",
    });
  }
});

const SubmissionSchema = z.object({
  title: z.string().min(1).max(256),
  body: z.string().max(65535).default(""),
  draft: z.boolean().default(true).describe(
    "Requested initial review state; adapters must not silently make it ready",
  ),
});

/** Input contract for creating one immutable delivery proposal. */
export const CreatePacketSchema = z.object({
  targetRepository: z.string().min(1).max(2048).describe(
    "Forge-neutral canonical target repository identity, such as git.example.org/group/project",
  ),
  sourceRepository: z.string().min(1).max(2048).describe(
    "Forge-neutral canonical repository that owns the head ref; equals targetRepository for a same-repository change",
  ),
  base: RevisionSchema,
  head: RevisionSchema,
  changedPaths: z.array(RelativePathSchema).max(10000).default([]),
  checks: z.array(CheckSchema).min(1).max(1000),
  submission: SubmissionSchema,
}).superRefine((input, context) => {
  if (input.base.ref === input.head.ref) {
    context.addIssue({
      code: "custom",
      path: ["head", "ref"],
      message: "must differ from the base ref",
    });
  }
  if (input.base.sha === input.head.sha) {
    context.addIssue({
      code: "custom",
      path: ["head", "sha"],
      message: "must differ from the base commit",
    });
  }

  const names = new Set<string>();
  for (const [index, check] of input.checks.entries()) {
    if (names.has(check.name)) {
      context.addIssue({
        code: "custom",
        path: ["checks", index, "name"],
        message: "must be unique within a packet",
      });
    }
    names.add(check.name);
  }

  if (!input.checks.some((check) => check.required)) {
    context.addIssue({
      code: "custom",
      path: ["checks"],
      message: "must include at least one required check",
    });
  }
});

const ReadinessSchema = z.object({
  ready: z.boolean(),
  blockers: z.array(z.string()),
});

/** Canonical persisted representation of a change packet. */
export const PacketSchema = z.object({
  schemaVersion: z.literal(PacketSchemaVersion),
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  payloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
  targetRepository: z.string().min(1),
  sourceRepository: z.string().min(1),
  base: RevisionSchema,
  head: RevisionSchema,
  changedPaths: z.array(RelativePathSchema),
  checks: z.array(CheckSchema),
  submission: SubmissionSchema,
  readiness: ReadinessSchema,
});

const VerificationSchema = z.object({
  packetId: z.uuid(),
  valid: z.boolean(),
  expectedDigest: z.string().regex(/^[0-9a-f]{64}$/),
  actualDigest: z.string().regex(/^[0-9a-f]{64}$/),
  readiness: ReadinessSchema,
  mismatches: z.array(z.string()),
  verifiedAt: z.iso.datetime(),
});

type CreatePacket = z.infer<typeof CreatePacketSchema>;
type Packet = z.infer<typeof PacketSchema>;

function canonicalJson(value: unknown): string {
  if (
    value === null || typeof value === "boolean" || typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${
      Object.keys(object).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(object[key])}`
      ).join(",")
    }}`;
  }
  throw new Error(
    `Cannot canonicalize unsupported value type: ${typeof value}`,
  );
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function payloadOf(
  input: CreatePacket,
): CreatePacket & { schemaVersion: number } {
  return { schemaVersion: PacketSchemaVersion, ...input };
}

export function readinessOf(
  checks: z.infer<typeof CheckSchema>[],
): z.infer<typeof ReadinessSchema> {
  const blockers = checks
    .filter((check) => check.required && check.outcome !== "passed")
    .map((check) => `${check.name}: ${check.outcome}`);
  return { ready: blockers.length === 0, blockers };
}

/** Build a new immutable packet from validated local evidence. */
export async function createPacket(
  rawInput: unknown,
  options: { id?: string; createdAt?: Date } = {},
): Promise<Packet> {
  const input = CreatePacketSchema.parse(rawInput);
  const id = options.id ?? crypto.randomUUID();
  const createdAt = options.createdAt ?? new Date();
  const packet = {
    ...payloadOf(input),
    id,
    createdAt: createdAt.toISOString(),
    payloadDigest: await sha256(payloadOf(input)),
    readiness: readinessOf(input.checks),
  };
  return PacketSchema.parse(packet);
}

/** Recompute the semantic digest and derived readiness for an untrusted packet. */
export async function verifyPacket(
  rawPacket: unknown,
): Promise<z.infer<typeof VerificationSchema>> {
  const packet = PacketSchema.parse(rawPacket);
  const expectedDigest = await sha256(payloadOf({
    targetRepository: packet.targetRepository,
    sourceRepository: packet.sourceRepository,
    base: packet.base,
    head: packet.head,
    changedPaths: packet.changedPaths,
    checks: packet.checks,
    submission: packet.submission,
  }));
  const readiness = readinessOf(packet.checks);
  const mismatches: string[] = [];
  if (packet.payloadDigest !== expectedDigest) mismatches.push("payloadDigest");
  if (packet.readiness.ready !== readiness.ready) {
    mismatches.push("readiness.ready");
  }
  if (
    canonicalJson(packet.readiness.blockers) !==
      canonicalJson(readiness.blockers)
  ) {
    mismatches.push("readiness.blockers");
  }

  return VerificationSchema.parse({
    packetId: packet.id,
    valid: mismatches.length === 0,
    expectedDigest,
    actualDigest: packet.payloadDigest,
    readiness,
    mismatches,
    verifiedAt: new Date().toISOString(),
  });
}

/** Model definition for durable, forge-neutral delivery proposals. */
export const model = {
  type: "@jeremy/change-packet",
  version: "2026.08.21.1",
  description:
    "Create and verify immutable, forge-neutral change packets from Git identity and validation evidence. Performs no network or repository mutation.",
  globalArguments: z.object({}),
  resources: {
    packet: {
      description:
        "Immutable change proposal with a canonical payload digest and derived readiness",
      schema: PacketSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
    verification: {
      description:
        "Integrity and readiness verification for a supplied change packet",
      schema: VerificationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
  },
  methods: {
    create: {
      description:
        "Create an immutable local proposal packet. This does not push, publish, open a review, or grant approval.",
      arguments: CreatePacketSchema,
      execute: async (args: CreatePacket, context: {
        writeResource: (
          spec: string,
          instance: string,
          data: unknown,
        ) => Promise<{ name: string }>;
        logger?: {
          info: (message: string, fields?: Record<string, unknown>) => void;
        };
      }) => {
        context.logger?.info("Creating immutable change packet");
        const packet = await createPacket(args);
        const handle = await context.writeResource(
          "packet",
          `packet-${packet.id}`,
          packet,
        );
        context.logger?.info("Created immutable change packet", {
          packetId: packet.id,
          ready: packet.readiness.ready,
        });
        return { dataHandles: [handle] };
      },
    },
    verify: {
      description:
        "Recompute a packet's canonical payload digest and derived readiness. Does not approve or submit it.",
      arguments: z.object({ packet: PacketSchema }),
      execute: async (args: { packet: Packet }, context: {
        writeResource: (
          spec: string,
          instance: string,
          data: unknown,
        ) => Promise<{ name: string }>;
        logger?: {
          info: (message: string, fields?: Record<string, unknown>) => void;
        };
      }) => {
        context.logger?.info("Verifying immutable change packet", {
          packetId: args.packet.id,
        });
        const verification = await verifyPacket(args.packet);
        const handle = await context.writeResource(
          "verification",
          `verification-${verification.packetId}`,
          verification,
        );
        context.logger?.info("Verified immutable change packet", {
          packetId: verification.packetId,
          valid: verification.valid,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
