import { z } from "npm:zod@4.4.3";
import { Packet, requireDraftPacket } from "./packet.ts";
import { preflight, PreflightConfigSchema } from "./preflight.ts";

export const DraftPlanSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  packetId: z.uuid(),
  packetDigest: z.string().regex(/^[0-9a-f]{64}$/),
  repository: z.string(),
  base: z.object({
    ref: z.string(),
    sha: z.string().regex(/^[0-9a-f]{40,64}$/),
  }),
  head: z.object({
    ref: z.string(),
    sha: z.string().regex(/^[0-9a-f]{40,64}$/),
  }),
  title: z.string(),
  body: z.string(),
  bodyDigest: z.string().regex(/^[0-9a-f]{64}$/),
  draft: z.literal(true),
  existingPullRequest: z.object({
    number: z.number().int().positive(),
    url: z.string(),
  }).nullable(),
});

export type DraftPlan = z.infer<typeof DraftPlanSchema>;

type FetchLike = typeof fetch;

async function getJson(
  fetchImpl: FetchLike,
  token: string,
  path: string,
): Promise<unknown> {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jeremy-swamp-github-draft-pr",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub plan ${path} failed with HTTP ${response.status}`);
  }
  return await response.json();
}

async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(hash),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Build a read-only plan after binding a ready packet to exact remote refs. */
export async function planDraft(
  rawConfig: unknown,
  rawPacket: unknown,
  fetchImpl: FetchLike = fetch,
): Promise<DraftPlan> {
  const config = PreflightConfigSchema.parse(rawConfig);
  const packet: Packet = await requireDraftPacket(rawPacket);
  if (packet.targetRepository !== config.repository) {
    throw new Error("Packet targetRepository does not match bound repository");
  }
  if (packet.sourceRepository !== packet.targetRepository) {
    throw new Error(
      "Fork and cross-repository packets are not supported by this adapter",
    );
  }
  if (packet.base.ref !== config.baseBranch) {
    throw new Error("Packet base ref does not match bound baseBranch");
  }

  const checked = await preflight(config, fetchImpl);
  if (checked.baseSha !== packet.base.sha) {
    throw new Error("Remote base SHA does not match packet base SHA");
  }

  const head = await getJson(
    fetchImpl,
    config.token,
    `/repos/${config.repository}/git/ref/heads/${
      encodeURIComponent(packet.head.ref)
    }`,
  ) as { object?: { sha?: unknown } };
  const headSha = typeof head.object?.sha === "string"
    ? head.object.sha.toLowerCase()
    : "";
  if (headSha !== packet.head.sha) {
    throw new Error("Remote head SHA does not match packet head SHA");
  }

  const owner = config.repository.split("/", 1)[0];
  const query = new URLSearchParams({
    state: "open",
    head: `${owner}:${packet.head.ref}`,
    base: packet.base.ref,
    per_page: "100",
  });
  const pulls = await getJson(
    fetchImpl,
    config.token,
    `/repos/${config.repository}/pulls?${query}`,
  ) as Array<{ number?: unknown; html_url?: unknown }>;
  const existing = pulls.length === 0 ? null : pulls[0];

  return DraftPlanSchema.parse({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    packetId: packet.id,
    packetDigest: packet.payloadDigest,
    repository: config.repository,
    base: packet.base,
    head: packet.head,
    title: packet.submission.title,
    body: packet.submission.body,
    bodyDigest: await sha256(packet.submission.body),
    draft: true,
    existingPullRequest: existing === null
      ? null
      : { number: existing.number, url: existing.html_url },
  });
}
