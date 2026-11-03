import { assertEquals } from "jsr:@std/assert@1.0.19";
import { createPacket } from "../change-packet/mod.ts";
import { GhRunner } from "./auth.ts";
import { applyPr } from "./apply.ts";
import { planPr } from "./plan.ts";
import { preflight } from "./preflight.ts";
import { verifyPr } from "./verify.ts";

const config = {
  repository: "owner/repository",
  baseBranch: "main",
  expectedActor: "delivery-bot",
  authMode: "gh" as const,
};
const sha = (letter: string) => letter.repeat(40);

const unusedFetch = (() => {
  throw new Error("fetch must not be used in gh mode");
}) as typeof fetch;

function ghMock() {
  const calls: string[][] = [];
  const runner: GhRunner = (args) => {
    calls.push([...args]);
    const method = args[4];
    const endpoint = args[5];
    let body: unknown;
    if (method === "GET" && endpoint === "user") {
      body = { login: "delivery-bot" };
    } else if (
      method === "GET" && endpoint === "repos/owner/repository"
    ) {
      body = {
        id: 42,
        full_name: "owner/repository",
        default_branch: "main",
      };
    } else if (
      method === "GET" &&
      endpoint === "repos/owner/repository/git/ref/heads/main"
    ) {
      body = { object: { sha: sha("a") } };
    } else if (
      method === "GET" &&
      endpoint === "repos/owner/repository/git/ref/heads/feature%2Fchange"
    ) {
      body = { object: { sha: sha("b") } };
    } else if (
      method === "GET" &&
      endpoint?.startsWith("repos/owner/repository/pulls?")
    ) {
      body = [];
    } else if (
      method === "POST" &&
      endpoint === "repos/owner/repository/pulls"
    ) {
      body = {
        number: 12,
        html_url: "https://github.com/owner/repository/pull/12",
      };
    } else if (
      method === "GET" &&
      endpoint === "repos/owner/repository/pulls/12"
    ) {
      body = {
        html_url: "https://github.com/owner/repository/pull/12",
        draft: false,
        title: "test title",
        body: "test body",
        head: { ref: "feature/change", sha: sha("b") },
        base: { ref: "main", sha: sha("a") },
      };
    } else {
      throw new Error(`Unexpected gh route: ${method} ${endpoint}`);
    }
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify(body),
      stderr: "",
    });
  };
  return { calls, runner };
}

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
    submission: { title: "test title", body: "test body", draft: false },
  });
}

Deno.test("preflight uses gh authentication through the adapter boundary", async () => {
  const mock = ghMock();
  const result = await preflight(
    config,
    unusedFetch,
    undefined,
    mock.runner,
  );

  assertEquals(result, {
    actor: "delivery-bot",
    repository: "owner/repository",
    repositoryId: 42,
    defaultBranch: "main",
    baseBranch: "main",
    baseSha: sha("a"),
  });
  assertEquals(mock.calls.length, 3);
});

Deno.test("plan and apply use gh authentication through the adapter boundary", async () => {
  const mock = ghMock();
  const p = await packet();
  const plan = await planPr(config, p, unusedFetch, mock.runner);
  const result = await applyPr(
    config,
    p,
    plan,
    unusedFetch,
    mock.runner,
  );

  assertEquals(result, {
    number: 12,
    url: "https://github.com/owner/repository/pull/12",
    created: true,
    draft: false,
  });
  assertEquals(
    mock.calls.some((call) =>
      call[4] === "POST" && call[5] === "repos/owner/repository/pulls"
    ),
    true,
  );
});

Deno.test("verify uses gh authentication through the adapter boundary", async () => {
  const mock = ghMock();
  const p = await packet();
  const result = await verifyPr(
    config,
    p,
    {
      number: 12,
      url: "https://github.com/owner/repository/pull/12",
      created: true,
      draft: false,
    },
    unusedFetch,
    mock.runner,
  );

  assertEquals(result, {
    number: 12,
    url: "https://github.com/owner/repository/pull/12",
    draft: false,
    verified: true,
  });
  assertEquals(mock.calls.length, 1);
});
