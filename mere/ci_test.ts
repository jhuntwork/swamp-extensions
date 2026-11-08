import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { parseRun, parseRunList } from "./ci.ts";

const run = (id: number, updatedAt: string) => ({
  databaseId: id,
  status: "completed",
  conclusion: "success",
  url: `https://github.com/jhuntwork/merelinux/actions/runs/${id}`,
  headSha: "a".repeat(40),
  event: "push",
  displayTitle: "Build recipes",
  createdAt: "2026-11-08T00:00:00Z",
  updatedAt,
});

Deno.test("parseRunList sorts newest Actions run first", () => {
  const parsed = parseRunList(JSON.stringify([
    run(1, "2026-11-08T00:01:00Z"),
    run(2, "2026-11-08T00:02:00Z"),
  ]));
  assertEquals(parsed.map((item) => item.databaseId), [2, 1]);
});

Deno.test("parseRun reads one Actions run object", () => {
  assertEquals(
    parseRun(JSON.stringify(run(7, "2026-11-08T00:01:00Z"))),
    run(7, "2026-11-08T00:01:00Z"),
  );
});

Deno.test("parseRunList rejects a non-array response", () => {
  assertRejects(
    () => Promise.resolve().then(() => parseRunList("{}")),
    Error,
    "did not return an array",
  );
});
