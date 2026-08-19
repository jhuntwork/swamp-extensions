import { z } from "npm:zod@4.4.3";

const GitShaSchema = z.string()
  .regex(/^[0-9a-fA-F]{40,64}$/, "must be a full hexadecimal Git object ID")
  .transform((value) => value.toLowerCase());

const GitRefSchema = z.string()
  .min(1)
  .max(512)
  .refine((value) => !/\\s/.test(value), "must not contain whitespace");

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
  required: z.boolean(),
  outcome: z.enum(["passed", "failed", "skipped", "unavailable"]),
  evidenceRef: z.string().min(1).max(2048),
  detail: z.string().max(4096),
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
  body: z.string().max(65535),
  draft: z.boolean(),
});

/** Materialized Change Packet Protocol v1 data accepted by the GitHub adapter. */
export const PacketSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  payloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
  targetRepository: z.string().min(1).max(2048),
  sourceRepository: z.string().min(1).max(2048),
  base: RevisionSchema,
  head: RevisionSchema,
  changedPaths: z.array(RelativePathSchema).max(10000),
  checks: z.array(CheckSchema).min(1).max(1000),
  submission: SubmissionSchema,
  readiness: z.object({ ready: z.boolean(), blockers: z.array(z.string()) }),
}).superRefine((packet, context) => {
  if (packet.base.ref === packet.head.ref) {
    context.addIssue({
      code: "custom",
      path: ["head", "ref"],
      message: "must differ from the base ref",
    });
  }
  if (packet.base.sha === packet.head.sha) {
    context.addIssue({
      code: "custom",
      path: ["head", "sha"],
      message: "must differ from the base commit",
    });
  }

  const names = new Set<string>();
  for (const [index, check] of packet.checks.entries()) {
    if (names.has(check.name)) {
      context.addIssue({
        code: "custom",
        path: ["checks", index, "name"],
        message: "must be unique within a packet",
      });
    }
    names.add(check.name);
  }

  if (!packet.checks.some((check) => check.required)) {
    context.addIssue({
      code: "custom",
      path: ["checks"],
      message: "must include at least one required check",
    });
  }
});

export type Packet = z.infer<typeof PacketSchema>;

function canonical(value: unknown): string {
  if (
    value === null || ["boolean", "number", "string"].includes(typeof value)
  ) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${
    Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(object[key])}`
    ).join(",")
  }}`;
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(hash),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function readinessOf(
  checks: Array<z.infer<typeof CheckSchema>>,
): { ready: boolean; blockers: string[] } {
  const blockers = checks
    .filter((check) => check.required && check.outcome !== "passed")
    .map((check) => `${check.name}: ${check.outcome}`);
  return { ready: blockers.length === 0, blockers };
}

/**
 * Reject malformed, tampered, or unready packets before GitHub I/O.
 *
 * Draft state is carried by the packet rather than enforced here: a packet may
 * request an ordinary pull request or a draft, and the plan records whichever
 * was asked for so the approved plan and the created PR cannot disagree.
 */
export async function requirePacket(raw: unknown): Promise<Packet> {
  const packet = PacketSchema.parse(raw);
  const payload = {
    schemaVersion: packet.schemaVersion,
    targetRepository: packet.targetRepository,
    sourceRepository: packet.sourceRepository,
    base: packet.base,
    head: packet.head,
    changedPaths: packet.changedPaths,
    checks: packet.checks,
    submission: packet.submission,
  };
  if (await digest(payload) !== packet.payloadDigest) {
    throw new Error("Change packet payload digest does not match");
  }
  const readiness = readinessOf(packet.checks);
  if (
    packet.readiness.ready !== readiness.ready ||
    canonical(packet.readiness.blockers) !== canonical(readiness.blockers)
  ) {
    throw new Error("Change packet derived readiness does not match checks");
  }
  if (!readiness.ready) {
    throw new Error("Change packet is not ready for submission");
  }
  return packet;
}
