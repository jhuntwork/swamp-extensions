import { assertEquals } from "jsr:@std/assert@1.0.19";
import { createPacket } from "../change-packet/mod.ts";
import { applyDraft } from "./apply.ts";
import { planDraft } from "./plan.ts";

const config = {
  repository: "owner/repository",
  baseBranch: "main",
  expectedActor: "delivery-bot",
  token: "test-token",
};
const sha = (letter: string) => letter.repeat(40);

async function packet() {
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
    submission: { title: "test title", body: "test body", draft: true },
  });
}

function routes(
  pulls: unknown[],
  created?: unknown,
  postStatus = 200,
  laterPulls: unknown[] = pulls,
) {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  let pullReads = 0;
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? init.body : null,
    });
    const pullUrl =
      "https://api.github.com/repos/owner/repository/pulls?state=open&head=owner%3Afeature%2Fchange&base=main&per_page=100";
    const pullBody = url === pullUrl
      ? pullReads++ < 2 ? pulls : laterPulls
      : pulls;
    const bodies: Record<string, unknown> = {
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
      [pullUrl]: pullBody,
      "https://api.github.com/repos/owner/repository/pulls": created,
    };
    const status = url === "https://api.github.com/repos/owner/repository/pulls"
      ? postStatus
      : 200;
    return Promise.resolve(
      new Response(JSON.stringify(bodies[url]), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

Deno.test("applyDraft recognizes an existing PR without POST", async () => {
  const mock = routes([{
    number: 7,
    html_url: "https://github.com/owner/repository/pull/7",
  }]);
  const p = await packet();
  const plan = await planDraft(config, p, mock.fetchImpl);
  const result = await applyDraft(config, p, plan, mock.fetchImpl);
  assertEquals(result.created, false);
  assertEquals(mock.calls.some((call) => call.method === "POST"), false);
});

Deno.test("applyDraft creates exactly one draft PR with planned fields", async () => {
  const mock = routes([], {
    number: 8,
    html_url: "https://github.com/owner/repository/pull/8",
  });
  const p = await packet();
  const plan = await planDraft(config, p, mock.fetchImpl);
  const result = await applyDraft(config, p, plan, mock.fetchImpl);
  const post = mock.calls.find((call) => call.method === "POST");
  assertEquals(result, {
    number: 8,
    url: "https://github.com/owner/repository/pull/8",
    created: true,
  });
  assertEquals(
    post?.url,
    "https://api.github.com/repos/owner/repository/pulls",
  );
  assertEquals(JSON.parse(post?.body ?? "{}"), {
    title: "test title",
    head: "feature/change",
    base: "main",
    body: "test body",
    draft: true,
  });
});

Deno.test("applyDraft reads back once when creation races with an existing PR", async () => {
  const mock = routes(
    [],
    undefined,
    422,
    [{
      number: 9,
      html_url: "https://github.com/owner/repository/pull/9",
    }],
  );
  const p = await packet();
  const plan = await planDraft(config, p, mock.fetchImpl);
  const result = await applyDraft(config, p, plan, mock.fetchImpl);

  assertEquals(result, {
    number: 9,
    url: "https://github.com/owner/repository/pull/9",
    created: false,
  });
  assertEquals(mock.calls.filter((call) => call.method === "POST").length, 1);
});
