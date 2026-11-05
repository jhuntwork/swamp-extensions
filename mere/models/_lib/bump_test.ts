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

Deno.test("a plain patch bump has release notes, evidence and dependents, nothing the diff shows", () => {
  const s = renderSummary({
    ...base,
    bump: {
      ...base.bump,
      releaseNotesUrl: "https://github.com/o/r/releases/tag/2.3.4",
    },
  });
  assertEquals(s.title, "zlib-ng: upgrade to 2.3.4");
  assertEquals(s.commitMessage, s.title);
  assertEquals(s.labels, ["automated", "bump"]);
  assertEquals(
    s.body,
    [
      "Release notes: https://github.com/o/r/releases/tag/2.3.4",
      "Built and validated locally on x86_64. Dependents: `curl`, `git`.",
      "Opened by recipe-bump (run `run-1`).",
    ].join("\n\n"),
  );
  // None of the things the diff already shows.
  for (const noise of ["blake3", "bytes", "sha256", "Source hashes", "## "]) {
    assertEquals(s.body.includes(noise), false, noise);
  }
});

Deno.test("no dependents and no release link: only the evidence and the run", () => {
  const s = renderSummary({ ...base, dependents: [] });
  assertEquals(
    s.body,
    [
      "Built and validated locally on x86_64.",
      "Opened by recipe-bump (run `run-1`).",
    ].join("\n\n"),
  );
});

Deno.test("migration review says why and what newer versions exist", () => {
  const s = renderSummary({
    ...base,
    bump: {
      ...base.bump,
      bumpKind: "minor",
      latestVersion: "2.5.0",
      latestInSeries: "2.3.9",
      targetSource: "explicit",
      needsMigration: true,
      hardcodedVersion: { exact: false, series: true },
    },
    dependents: [],
  });
  assertEquals(s.labels, ["automated", "bump", "needs-migration"]);
  assertEquals(s.body.startsWith("**Needs migration review:**"), true);
  assertEquals(s.body.includes("this is a minor update (2.3.3 → 2.3.4)"), true);
  assertEquals(s.body.includes("chosen explicitly"), true);
  assertEquals(s.body.includes("spell out its version or series"), true);
  assertEquals(s.body.includes("Newest upstream: 2.5.0."), true);
  assertEquals(s.body.includes("Newest in the current series: 2.3.9."), true);
});
