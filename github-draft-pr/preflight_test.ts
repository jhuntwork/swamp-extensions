import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { preflight } from "./preflight.ts";

const config = {
  repository: "owner/repository",
  baseBranch: "main",
  expectedActor: "delivery-bot",
  token: "test-token",
};

function fetchMock(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const route = routes[url];
    if (!route) throw new Error(`Unexpected GitHub mock route: ${url}`);
    calls.push({
      url,
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    return Promise.resolve(
      new Response(
        JSON.stringify(route.body),
        {
          status: route.status ?? 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
  };
  return { fetchImpl, calls };
}

Deno.test("preflight verifies exact actor, repository, and base ref", async () => {
  const { fetchImpl, calls } = fetchMock({
    "https://api.github.com/user": { body: { login: "delivery-bot" } },
    "https://api.github.com/repos/owner/repository": {
      body: { id: 42, full_name: "owner/repository", default_branch: "main" },
    },
    "https://api.github.com/repos/owner/repository/git/ref/heads/main": {
      body: { object: { sha: "A".repeat(40) } },
    },
  });

  const result = await preflight(config, fetchImpl);
  assertEquals(result, {
    actor: "delivery-bot",
    repository: "owner/repository",
    repositoryId: 42,
    defaultBranch: "main",
    baseBranch: "main",
    baseSha: "a".repeat(40),
  });
  assertEquals(calls.map((call) => call.url), [
    "https://api.github.com/user",
    "https://api.github.com/repos/owner/repository",
    "https://api.github.com/repos/owner/repository/git/ref/heads/main",
  ]);
  assertEquals(
    calls.every((call) => call.authorization === "Bearer test-token"),
    true,
  );
});

Deno.test("preflight rejects an unexpected authenticated actor", async () => {
  const { fetchImpl } = fetchMock({
    "https://api.github.com/user": { body: { login: "wrong-user" } },
  });
  await assertRejects(
    () => preflight(config, fetchImpl),
    Error,
    "does not match expectedActor",
  );
});

Deno.test("preflight rejects an incorrect repository identity", async () => {
  const { fetchImpl } = fetchMock({
    "https://api.github.com/user": { body: { login: "delivery-bot" } },
    "https://api.github.com/repos/owner/repository": {
      body: { id: 42, full_name: "other/repository", default_branch: "main" },
    },
  });
  await assertRejects(
    () => preflight(config, fetchImpl),
    Error,
    "bound repository",
  );
});

Deno.test("preflight surfaces a missing configured base ref", async () => {
  const { fetchImpl } = fetchMock({
    "https://api.github.com/user": { body: { login: "delivery-bot" } },
    "https://api.github.com/repos/owner/repository": {
      body: { id: 42, full_name: "owner/repository", default_branch: "main" },
    },
    "https://api.github.com/repos/owner/repository/git/ref/heads/main": {
      status: 404,
      body: { message: "Not Found" },
    },
  });
  await assertRejects(() => preflight(config, fetchImpl), Error, "HTTP 404");
});
