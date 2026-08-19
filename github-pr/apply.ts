import { z } from "npm:zod@4.4.3";
import { planPr, PlanSchema } from "./plan.ts";
import { requirePacket } from "./packet.ts";

type FetchLike = typeof fetch;

export const ApplyResultSchema = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  created: z.boolean(),
  draft: z.boolean(),
});

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

/** Apply an approved same-repository plan; never merges or updates a PR. */
export async function applyPr(
  config: unknown,
  rawPacket: unknown,
  rawPlan: unknown,
  fetchImpl: FetchLike = fetch,
): Promise<z.infer<typeof ApplyResultSchema>> {
  const packet = await requirePacket(rawPacket);
  const approved = PlanSchema.parse(rawPlan);
  if (
    approved.packetId !== packet.id ||
    approved.packetDigest !== packet.payloadDigest ||
    approved.repository !== packet.targetRepository ||
    approved.base.ref !== packet.base.ref ||
    approved.base.sha !== packet.base.sha ||
    approved.head.ref !== packet.head.ref ||
    approved.head.sha !== packet.head.sha ||
    approved.title !== packet.submission.title ||
    approved.body !== packet.submission.body ||
    approved.bodyDigest !== await sha256(packet.submission.body) ||
    approved.draft !== packet.submission.draft
  ) {
    throw new Error("Approved plan does not match the change packet");
  }

  // Re-plan only to re-read current refs and discover a concurrent existing PR.
  const current = await planPr(config, packet, fetchImpl);
  if (current.existingPullRequest) {
    return ApplyResultSchema.parse({
      number: current.existingPullRequest.number,
      url: current.existingPullRequest.url,
      created: false,
      draft: approved.draft,
    });
  }

  const parsed = z.object({ repository: z.string(), token: z.string() }).parse(
    config,
  );
  const response = await fetchImpl(
    `https://api.github.com/repos/${parsed.repository}/pulls`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${parsed.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "jeremy-swamp-github-pr",
      },
      body: JSON.stringify({
        title: approved.title,
        head: approved.head.ref,
        base: approved.base.ref,
        body: approved.body,
        draft: approved.draft,
      }),
    },
  );
  if (!response.ok) {
    if (response.status === 422) {
      // GitHub can report a concurrent duplicate as unprocessable. Perform
      // exactly one read-back before surfacing the failure.
      const raced = await planPr(config, packet, fetchImpl);
      if (raced.existingPullRequest) {
        return ApplyResultSchema.parse({
          number: raced.existingPullRequest.number,
          url: raced.existingPullRequest.url,
          created: false,
          draft: approved.draft,
        });
      }
    }
    throw new Error(
      `GitHub pull request creation failed with HTTP ${response.status}`,
    );
  }
  const created = await response.json() as {
    number?: unknown;
    html_url?: unknown;
  };
  return ApplyResultSchema.parse({
    number: created.number,
    url: created.html_url,
    created: true,
    draft: approved.draft,
  });
}
