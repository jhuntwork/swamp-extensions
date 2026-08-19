import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { createPacket } from "../change-packet/mod.ts";
import { planDraft } from "./plan.ts";

const config = {
  repository: "owner/repository",
  baseBranch: "main",
  expectedActor: "delivery-bot",
  token: "test-token",
};
const sha = (letter: string) => letter.repeat(40);

function mock(routes: Record<string, unknown>) {
  return ((input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    if (!(url in routes)) throw new Error(`unexpected route ${url}`);
    return Promise.resolve(
      new Response(JSON.stringify(routes[url]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

async function packet(sourceRepository = "owner/repository") {
  return await createPacket({
    targetRepository: "owner/repository",
    sourceRepository,
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
    submission: { title: "test", body: "body", draft: true },
  });
}

Deno.test("planDraft binds a packet to remote refs and discovers an existing PR", async () => {
  const p = await packet();
  const fetchImpl = mock({
    "https://api.github.com/user": { login: "delivery-bot" },
    "https://api.github.com/repos/owner/repository": {
      id: 1,
      full_name: "owner/repository",
      default_branch: "main",
    },
    "https://api.github.com/repos/owner/repository/git/ref/heads/main": {
      object: { sha: sha("a") },
    },
    "https://api.github.com/repos/owner/repository/git/ref/heads/feature%2Fchange":
      { object: { sha: sha("b") } },
    "https://api.github.com/repos/owner/repository/pulls?state=open&head=owner%3Afeature%2Fchange&base=main&per_page=100":
      [{ number: 7, html_url: "https://github.com/owner/repository/pull/7" }],
  });
  const plan = await planDraft(config, p, fetchImpl);
  assertEquals(plan.existingPullRequest?.number, 7);
  assertEquals(plan.base.sha, sha("a"));
});

Deno.test("planDraft rejects forks before GitHub I/O", async () => {
  await assertRejects(
    async () => planDraft(config, await packet("fork/repository"), mock({})),
    Error,
    "Fork",
  );
});
