import { z } from "npm:zod@4.4.3";
import { ApplyResultSchema } from "./apply.ts";
import { requirePacket } from "./packet.ts";
import { PreflightConfigSchema } from "./preflight.ts";

type FetchLike = typeof fetch;

export const VerificationSchema = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  draft: z.boolean(),
  verified: z.literal(true),
});

/** Read back a pull request and prove it still matches the exact packet. */
export async function verifyPr(
  rawConfig: unknown,
  rawPacket: unknown,
  rawResult: unknown,
  fetchImpl: FetchLike = fetch,
): Promise<z.infer<typeof VerificationSchema>> {
  const config = PreflightConfigSchema.parse(rawConfig);
  const packet = await requirePacket(rawPacket);
  const result = ApplyResultSchema.parse(rawResult);
  const response = await fetchImpl(
    `https://api.github.com/repos/${config.repository}/pulls/${result.number}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${config.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub PR verification failed with HTTP ${response.status}`,
    );
  }
  const pr = await response.json() as {
    html_url?: unknown;
    draft?: unknown;
    title?: unknown;
    body?: unknown;
    head?: { ref?: unknown; sha?: unknown };
    base?: { ref?: unknown; sha?: unknown };
  };
  if (pr.html_url !== result.url) {
    throw new Error("GitHub PR URL does not match applied result");
  }
  // The packet requested a specific draft state; read it back rather than
  // assuming either value, so a PR created as one kind cannot verify as another.
  if (pr.draft !== packet.submission.draft) {
    throw new Error("GitHub PR draft state does not match packet");
  }
  if (
    pr.title !== packet.submission.title || pr.body !== packet.submission.body
  ) throw new Error("GitHub PR content does not match packet");
  if (
    pr.head?.ref !== packet.head.ref ||
    String(pr.head?.sha).toLowerCase() !== packet.head.sha
  ) throw new Error("GitHub PR head does not match packet");
  if (
    pr.base?.ref !== packet.base.ref ||
    String(pr.base?.sha).toLowerCase() !== packet.base.sha
  ) throw new Error("GitHub PR base does not match packet");
  return VerificationSchema.parse({
    number: result.number,
    url: result.url,
    draft: packet.submission.draft,
    verified: true,
  });
}
