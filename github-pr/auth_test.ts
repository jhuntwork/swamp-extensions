import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { GhRunner, GithubApiError, githubJson } from "./auth.ts";

const unusedFetch = (() => {
  throw new Error("fetch must not be used in gh mode");
}) as typeof fetch;

Deno.test("githubJson uses the active gh login without a token", async () => {
  const calls: string[][] = [];
  const runner: GhRunner = (args) => {
    calls.push([...args]);
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ login: "jhuntwork" }),
      stderr: "",
    });
  };

  const result = await githubJson(
    { authMode: "gh" },
    "/user",
    {},
    unusedFetch,
    runner,
  );

  assertEquals(result, { login: "jhuntwork" });
  assertEquals(calls, [[
    "api",
    "--hostname",
    "github.com",
    "--method",
    "GET",
    "user",
  ]]);
});

Deno.test("githubJson passes PR fields as typed gh arguments", async () => {
  const calls: string[][] = [];
  const runner: GhRunner = (args) => {
    calls.push([...args]);
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ number: 12 }),
      stderr: "",
    });
  };

  await githubJson(
    { authMode: "gh" },
    "/repos/owner/repository/pulls",
    {
      method: "POST",
      body: {
        title: "title with spaces",
        head: "feature/change",
        base: "main",
        body: "body",
        draft: false,
      },
    },
    unusedFetch,
    runner,
  );

  assertEquals(calls[0], [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "POST",
    "repos/owner/repository/pulls",
    "--raw-field",
    "title=title with spaces",
    "--raw-field",
    "head=feature/change",
    "--raw-field",
    "base=main",
    "--raw-field",
    "body=body",
    "--field",
    "draft=false",
  ]);
});

Deno.test("githubJson requires a token in token mode", async () => {
  await assertRejects(
    () => githubJson({ authMode: "token" }, "/user", {}, unusedFetch),
    Error,
    "token is required",
  );
});

Deno.test("githubJson preserves an HTTP status reported by gh", async () => {
  const runner: GhRunner = () =>
    Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "gh: Not Found (HTTP 404)",
    });

  await assertRejects(
    () => githubJson({ authMode: "gh" }, "/missing", {}, unusedFetch, runner),
    GithubApiError,
    "HTTP 404",
  );
});
