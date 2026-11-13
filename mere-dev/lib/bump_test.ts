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

Deno.test("a bump body contains only upstream release context", () => {
  const s = renderSummary({
    ...base,
    bump: {
      ...base.bump,
      releaseNotesUrl: "https://github.com/o/r/releases/tag/2.3.4",
      releaseSummary: "This release fixes a parser bug and adds a setting.",
    },
  });
  assertEquals(s.title, "zlib-ng: upgrade to 2.3.4");
  assertEquals(s.commitMessage, s.title);
  assertEquals(s.labels, ["automated", "bump"]);
  assertEquals(
    s.body,
    "This release fixes a parser bug and adds a setting. Release notes: " +
      "https://github.com/o/r/releases/tag/2.3.4",
  );
});

Deno.test("no release summary falls back to the release link only", () => {
  const s = renderSummary({
    ...base,
    dependents: [],
    bump: {
      ...base.bump,
      releaseNotesUrl: "https://github.com/o/r/releases/tag/2.3.4",
    },
  });
  assertEquals(
    s.body,
    "Release notes: https://github.com/o/r/releases/tag/2.3.4",
  );
});

Deno.test("migration state changes labels, not the maintainer-facing body", () => {
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
      releaseSummary: "This release adds a setting.",
      releaseNotesUrl: "https://github.com/o/r/releases/tag/2.3.4",
    },
    dependents: [],
  });
  assertEquals(s.labels, ["automated", "bump", "needs-migration"]);
  assertEquals(
    s.body,
    "This release adds a setting. Release notes: " +
      "https://github.com/o/r/releases/tag/2.3.4",
  );
});
