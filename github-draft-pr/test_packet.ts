import { type Packet, PacketSchema } from "./packet.ts";

type PacketInput = Omit<
  Packet,
  "schemaVersion" | "id" | "createdAt" | "payloadDigest" | "readiness"
>;

function canonical(value: unknown): string {
  if (
    value === null || typeof value === "boolean" || typeof value === "number" ||
    typeof value === "string"
  ) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${
      Object.keys(object).sort().map((key) =>
        `${JSON.stringify(key)}:${canonical(object[key])}`
      ).join(",")
    }}`;
  }
  throw new Error(`Cannot canonicalize ${typeof value}`);
}

async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(value)),
  );
  return Array.from(
    new Uint8Array(hash),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Build a valid protocol-v1 packet without depending on a sibling extension. */
export async function createPacket(input: PacketInput): Promise<Packet> {
  const payload = { schemaVersion: 1 as const, ...input };
  const blockers = input.checks
    .filter((check) => check.required && check.outcome !== "passed")
    .map((check) => `${check.name}: ${check.outcome}`);
  return PacketSchema.parse({
    ...payload,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    payloadDigest: await digest(payload),
    readiness: { ready: blockers.length === 0, blockers },
  });
}
