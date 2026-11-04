import { assertEquals } from "./assert_test.ts";
import { driftMarkdown, summarizeDrift, type UpstreamRecord } from "./drift.ts";

const records: UpstreamRecord[] = [
  {
    name: "zlib-ng",
    currentVersion: "2.3.3",
    latestVersion: "2.3.3",
    isNewer: false,
    provider: "github",
  },
  {
    name: "curl",
    currentVersion: "8.19.0",
    latestVersion: "8.23.0",
    isNewer: true,
    provider: "anitya",
  },
  {
    name: "bash",
    currentVersion: "5.3",
    isNewer: false,
    provider: "anitya",
    note: "no Anitya project | named bash",
  },
  {
    name: "git",
    currentVersion: "2.53.0",
    latestVersion: "2.56.0",
    isNewer: true,
    provider: "github",
  },
];

Deno.test("summarizeDrift counts and sorts", () => {
  const d = summarizeDrift(records);
  assertEquals(d.total, 4);
  assertEquals(d.behind.map((r) => r.name), ["curl", "git"]);
  assertEquals(d.unresolved.map((r) => r.name), ["bash"]);
  assertEquals(d.current, 1);
  assertEquals(d.byProvider.github, { found: 2, behind: 1 });
  assertEquals(d.byProvider.anitya, { found: 1, behind: 1 });
});

Deno.test("driftMarkdown renders tables, escapes pipes, lists scan problems", () => {
  const md = driftMarkdown(
    summarizeDrift(records, {
      commit: "0123456789abcdef",
      failures: [{ path: "recipes/core/x/recipe.kdl", error: "bad" }],
      normalized: ["recipes/core/bzip2/recipe.kdl"],
    }),
  );
  assertEquals(md.includes("**2 behind upstream**"), true);
  assertEquals(md.includes("| curl | 8.19.0 | 8.23.0 | anitya |"), true);
  assertEquals(md.includes("no Anitya project \\| named bash"), true);
  assertEquals(md.includes("`0123456789`"), true);
  assertEquals(md.includes("failed to parse"), true);
  assertEquals(md.includes("recipes/core/bzip2/recipe.kdl"), true);
});

Deno.test("driftMarkdown handles an empty and an all-current scan", () => {
  assertEquals(
    driftMarkdown(summarizeDrift([])).includes("0 recipes checked"),
    true,
  );
  const md = driftMarkdown(summarizeDrift([records[0]]));
  assertEquals(md.includes("## Behind upstream\n\nNone."), true);
});
