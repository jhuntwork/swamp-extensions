import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { createPacket } from "./test_packet.ts";
import { verifyDraft } from "./verify.ts";

const config = {
  repository: "owner/repository",
  baseBranch: "main",
  expectedActor: "delivery-bot",
  token: "test-token",
};
const sha = (letter: string) => letter.repeat(40);

async function packet(body = "body") {
  return await createPacket({
    targetRepository: "owner/repository",
    sourceRepository: "owner/repository",
    base: { ref: "main", sha: sha("a") },
    head: { ref: "feature/change", sha: sha("b") },
    changedPaths: ["README.md"],
    checks: [{
      name: "test",
      required: true,
      outcome: "passed",
      evidenceRef: "evidence://test",
      detail: "",
    }],
    submission: { title: "test", body, draft: true },
  });
}

function fetchPr(pr: unknown) {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(pr), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )) as typeof fetch;
}

Deno.test("verifyDraft accepts an exact draft PR readback", async () => {
  const p = await packet();
  const result = await verifyDraft(
    config,
    p,
    {
      number: 8,
      url: "https://github.com/owner/repository/pull/8",
      created: true,
    },
    fetchPr({
      html_url: "https://github.com/owner/repository/pull/8",
      draft: true,
      title: "test",
      body: "body",
      head: { ref: "feature/change", sha: sha("b") },
      base: { ref: "main", sha: sha("a") },
    }),
  );
  assertEquals(result.verified, true);
});

Deno.test("verifyDraft treats GitHub's null empty body as an empty packet body", async () => {
  const p = await packet("");
  const result = await verifyDraft(
    config,
    p,
    {
      number: 9,
      url: "https://github.com/owner/repository/pull/9",
      created: true,
    },
    fetchPr({
      html_url: "https://github.com/owner/repository/pull/9",
      draft: true,
      title: "test",
      body: null,
      head: { ref: "feature/change", sha: sha("b") },
      base: { ref: "main", sha: sha("a") },
    }),
  );
  assertEquals(result.verified, true);
});

Deno.test("verifyDraft rejects a PR whose head no longer matches", async () => {
  const p = await packet();
  await assertRejects(
    () =>
      verifyDraft(
        config,
        p,
        {
          number: 8,
          url: "https://github.com/owner/repository/pull/8",
          created: true,
        },
        fetchPr({
          html_url: "https://github.com/owner/repository/pull/8",
          draft: true,
          title: "test",
          body: "body",
          head: { ref: "feature/change", sha: sha("c") },
          base: { ref: "main", sha: sha("a") },
        }),
      ),
    Error,
    "head",
  );
});
