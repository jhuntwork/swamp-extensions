import { z } from "npm:zod@4.4.3";
import { Packet, requirePacket } from "./packet.ts";
import { preflight, PreflightConfigSchema } from "./preflight.ts";

export const PlanSchema = z.object({
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
  draft: z.boolean().describe(
    "Whether the packet requested a draft pull request",
  ),
  existingPullRequest: z.object({
    number: z.number().int().positive(),
    url: z.string(),
  }).nullable(),
});

export type Plan = z.infer<typeof PlanSchema>;

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
      "User-Agent": "jeremy-swamp-github-pr",
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

/** Build a read-only plan after binding a ready packet to its remote head and base branch. */
export async function planPr(
  rawConfig: unknown,
  rawPacket: unknown,
  fetchImpl: FetchLike = fetch,
): Promise<Plan> {
  const config = PreflightConfigSchema.parse(rawConfig);
  const packet: Packet = await requirePacket(rawPacket);
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

  await preflight(config, fetchImpl);

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

  return PlanSchema.parse({
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
    draft: packet.submission.draft,
    existingPullRequest: existing === null
      ? null
      : { number: existing.number, url: existing.html_url },
  });
}
