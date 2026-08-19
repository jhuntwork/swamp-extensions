import { assertEquals } from "jsr:@std/assert@1.0.19";
import { createPacket } from "../change-packet/mod.ts";
import { applyPr } from "./apply.ts";
import { planPr } from "./plan.ts";

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
    submission: { title: "test title", body: "test body", draft },
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

Deno.test("applyPr recognizes an existing PR without POST", async () => {
  const mock = routes([{
    number: 7,
    html_url: "https://github.com/owner/repository/pull/7",
  }]);
  const p = await packet();
  const plan = await planPr(config, p, mock.fetchImpl);
  const result = await applyPr(config, p, plan, mock.fetchImpl);
  assertEquals(result.created, false);
  assertEquals(mock.calls.some((call) => call.method === "POST"), false);
});

// The default this adapter exists for: an ordinary reviewable pull request.
Deno.test("applyPr creates an ordinary PR when the packet does not request draft", async () => {
  const mock = routes([], {
    number: 8,
    html_url: "https://github.com/owner/repository/pull/8",
  });
  const p = await packet(false);
  const plan = await planPr(config, p, mock.fetchImpl);
  const result = await applyPr(config, p, plan, mock.fetchImpl);
  const post = mock.calls.find((call) => call.method === "POST");
  assertEquals(result, {
    number: 8,
    url: "https://github.com/owner/repository/pull/8",
    created: true,
    draft: false,
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
    draft: false,
  });
});

Deno.test("applyPr creates a draft PR when the packet requests one", async () => {
  const mock = routes([], {
    number: 9,
    html_url: "https://github.com/owner/repository/pull/9",
  });
  const p = await packet(true);
  const plan = await planPr(config, p, mock.fetchImpl);
  const result = await applyPr(config, p, plan, mock.fetchImpl);
  const post = mock.calls.find((call) => call.method === "POST");
  assertEquals(result.draft, true);
  assertEquals(JSON.parse(post?.body ?? "{}").draft, true);
});

// A plan is the reviewed artifact, so its draft state must survive to creation.
Deno.test("applyPr rejects a plan whose draft state disagrees with its packet", async () => {
  const mock = routes([], {
    number: 10,
    html_url: "https://github.com/owner/repository/pull/10",
  });
  const p = await packet(false);
  const plan = await planPr(config, p, mock.fetchImpl);
  let failed = false;
  try {
    await applyPr(config, p, { ...plan, draft: true }, mock.fetchImpl);
  } catch (error) {
    failed = String(error).includes("does not match the change packet");
  }
  assertEquals(failed, true);
  assertEquals(mock.calls.some((call) => call.method === "POST"), false);
});

Deno.test("applyPr reads back once when creation races with an existing PR", async () => {
  const mock = routes(
    [],
    undefined,
    422,
    [{
      number: 11,
      html_url: "https://github.com/owner/repository/pull/11",
    }],
  );
  const p = await packet();
  const plan = await planPr(config, p, mock.fetchImpl);
  const result = await applyPr(config, p, plan, mock.fetchImpl);

  assertEquals(result, {
    number: 11,
    url: "https://github.com/owner/repository/pull/11",
    created: false,
    draft: false,
  });
  assertEquals(mock.calls.filter((call) => call.method === "POST").length, 1);
});
