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
    bumpKind: "minor",
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
    name: "lua",
    currentVersion: "5.4.7",
    latestVersion: "5.5.1",
    latestInSeries: "5.4.8",
    bumpKind: "minor",
    isNewer: true,
    provider: "github",
  },
  {
    name: "linux",
    currentVersion: "6.18.42",
    latestVersion: "7.3",
    latestInSeries: "6.18.43",
    bumpKind: "major",
    isNewer: true,
    provider: "anitya",
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
  assertEquals(d.total, 6);
  assertEquals(d.behind.map((r) => r.name), ["linux", "curl", "lua", "git"]);
  assertEquals(d.unresolved.map((r) => r.name), ["bash"]);
  assertEquals(d.current, 1);
  assertEquals(d.byProvider.github, { found: 3, behind: 2 });
  assertEquals(d.byProvider.anitya, { found: 2, behind: 2 });
});

Deno.test("driftMarkdown renders tables, escapes pipes, lists scan problems", () => {
  const md = driftMarkdown(
    summarizeDrift(records, {
      commit: "0123456789abcdef",
      failures: [{ path: "recipes/core/x/recipe.kdl", error: "bad" }],
      normalized: ["recipes/core/bzip2/recipe.kdl"],
      hardcodedVersion: ["lua"],
    }),
  );
  assertEquals(md.includes("**4 behind upstream**"), true);
  assertEquals(
    md.includes("| curl | 8.19.0 | 8.23.0 | minor |  |  | anitya |"),
    true,
  );
  assertEquals(
    md.includes("| lua | 5.4.7 | 5.5.1 | minor | 5.4.8 | yes | github |"),
    true,
  );
  assertEquals(
    md.includes("| linux | 6.18.42 | 7.3 | major | 6.18.43 |  | anitya |"),
    true,
  );
  assertEquals(md.indexOf("| linux |") < md.indexOf("| curl |"), true);
  assertEquals(md.includes("## Recipes that hardcode their version\n"), true);
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

Deno.test("newest in series is shown only when it is a real step", () => {
  const md = driftMarkdown(summarizeDrift([
    {
      name: "harfbuzz",
      currentVersion: "14.1.0",
      latestVersion: "15.1.0",
      latestInSeries: "14.1.0",
      bumpKind: "major",
      isNewer: true,
      provider: "github",
    },
  ]));
  assertEquals(
    md.includes("| harfbuzz | 14.1.0 | 15.1.0 | major |  |  | github |"),
    true,
  );
});
