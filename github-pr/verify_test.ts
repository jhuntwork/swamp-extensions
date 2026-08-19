import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { createPacket } from "../change-packet/mod.ts";
import { verifyPr } from "./verify.ts";

const config = {
  repository: "owner/repository",
  baseBranch: "main",
  expectedActor: "delivery-bot",
  token: "test-token",
};
const sha = (letter: string) => letter.repeat(40);

async function packet(draft = false) {
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
    submission: { title: "test", body: "body", draft },
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

const applied = (draft: boolean) => ({
  number: 8,
  url: "https://github.com/owner/repository/pull/8",
  created: true,
  draft,
});

Deno.test("verifyPr accepts an exact ordinary PR readback", async () => {
  const result = await verifyPr(
    config,
    await packet(false),
    applied(false),
    fetchPr({
      html_url: "https://github.com/owner/repository/pull/8",
      draft: false,
      title: "test",
      body: "body",
      head: { ref: "feature/change", sha: sha("b") },
      base: { ref: "main", sha: sha("a") },
    }),
  );
  assertEquals(result.verified, true);
  assertEquals(result.draft, false);
});

Deno.test("verifyPr accepts an exact draft PR readback", async () => {
  const result = await verifyPr(
    config,
    await packet(true),
    applied(true),
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
  assertEquals(result.draft, true);
});

// Draft state is read back rather than assumed, in either direction.
Deno.test("verifyPr rejects a PR whose draft state differs from the packet", async () => {
  await assertRejects(
    async () =>
      verifyPr(
        config,
        await packet(false),
        applied(false),
        fetchPr({
          html_url: "https://github.com/owner/repository/pull/8",
          draft: true,
          title: "test",
          body: "body",
          head: { ref: "feature/change", sha: sha("b") },
          base: { ref: "main", sha: sha("a") },
        }),
      ),
    Error,
    "draft state",
  );

  await assertRejects(
    async () =>
      verifyPr(
        config,
        await packet(true),
        applied(true),
        fetchPr({
          html_url: "https://github.com/owner/repository/pull/8",
          draft: false,
          title: "test",
          body: "body",
          head: { ref: "feature/change", sha: sha("b") },
          base: { ref: "main", sha: sha("a") },
        }),
      ),
    Error,
    "draft state",
  );
});

Deno.test("verifyPr rejects a PR whose head no longer matches", async () => {
  await assertRejects(
    async () =>
      verifyPr(
        config,
        await packet(false),
        applied(false),
        fetchPr({
          html_url: "https://github.com/owner/repository/pull/8",
          draft: false,
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
