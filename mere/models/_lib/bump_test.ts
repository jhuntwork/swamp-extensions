import { assertEquals } from "./assert_test.ts";
import { findDependents, renderSummary, type SummaryInput } from "./bump.ts";

Deno.test("findDependents matches the package and its -dev package, not itself", () => {
  const recipes = [
    { name: "curl", depends: ["zlib-ng-dev", "openssl"] },
    { name: "zlib-ng", depends: ["zlib-ng-dev"] },
    { name: "git", depends: ["zlib-ng"] },
    { name: "bash", depends: ["readline"] },
  ];
  assertEquals(findDependents(recipes, "zlib-ng"), ["curl", "git"]);
  assertEquals(findDependents(recipes, "nothing"), []);
});

const base: SummaryInput = {
  name: "zlib-ng",
  recipe: "core/zlib-ng",
  runId: "run-1",
  change: {
    version: { before: "2.3.3", after: "2.3.4" },
    release: { before: 7, after: 1 },
    sources: [{
      url: "https://x/${recipe.version}.tgz",
      blake3Before: "a".repeat(64),
      blake3After: "b".repeat(64),
    }],
  },
  bump: {
    bumpKind: "patch",
    latestVersion: "2.3.4",
    latestInSeries: "2.3.4",
    targetSource: "latestInSeries",
    needsMigration: false,
    hardcodedVersion: { exact: false, series: false },
  },
  build: {
    arch: "x86_64",
    durationMs: 31_200,
    noCache: true,
    outputs: [{ package: "zlib-ng", sha256: "c".repeat(64), bytes: 1234 }],
  },
  dependents: ["curl", "git"],
};

Deno.test("renderSummary for a plain patch bump", () => {
  const s = renderSummary(base);
  assertEquals(s.title, "zlib-ng: upgrade to 2.3.4");
  assertEquals(s.commitMessage, s.title);
  assertEquals(s.labels, ["automated", "bump"]);
  assertEquals(s.body.includes("needs migration"), false);
  assertEquals(s.body.includes("2 recipes depend on it: `curl`, `git`"), true);
  assertEquals(
    renderSummary({ ...base, dependents: ["curl"] }).body.includes(
      "1 recipe depends on it",
    ),
    true,
  );
  const same = renderSummary({
    ...base,
    change: { ...base.change, release: { before: 1, after: 1 } },
    bump: { ...base.bump, latestInSeries: "2.3.3" },
  });
  assertEquals(same.body.includes("release 1)."), true);
  assertEquals(same.body.includes("current series"), false);
  assertEquals(s.body.includes("`zlib-ng` (1234 bytes"), true);
  assertEquals(s.body.includes("run `run-1`"), true);
  // Subject only: no body, no trailers, same text as the PR title.
  assertEquals(s.commitMessage, "zlib-ng: upgrade to 2.3.4");
});

Deno.test("renderSummary flags migration review and shows newer versions", () => {
  const s = renderSummary({
    ...base,
    bump: {
      ...base.bump,
      bumpKind: "minor",
      latestVersion: "2.5.0",
      targetSource: "explicit",
      needsMigration: true,
      hardcodedVersion: { exact: false, series: true },
    },
    dependents: [],
  });
  assertEquals(s.labels, ["automated", "bump", "needs-migration"]);
  assertEquals(s.body.includes("**Needs migration review:**"), true);
  assertEquals(s.body.includes("this is a minor update"), true);
  assertEquals(s.body.includes("chosen explicitly"), true);
  assertEquals(s.body.includes("spell out its version or series"), true);
  assertEquals(s.body.includes("Newest upstream: 2.5.0"), true);
  assertEquals(s.body.includes("No other recipe depends on this one."), true);
});
