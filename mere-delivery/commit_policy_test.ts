import { assertEquals } from "jsr:@std/assert@1.0.19";
import { checkCommit, parseRawCommit } from "./commit_policy.ts";
import { PROFILES } from "./profiles.ts";

const v = (profile: keyof typeof PROFILES, message: string, extra = {}) =>
  checkCommit({ message, ...extra }, PROFILES[profile]);

Deno.test("mere: a feature may explain why in a body", () => {
  assertEquals(
    v(
      "mere",
      "Remove a generation when its activation is refused\n\nThe new generation stayed on disk and counted toward GC retention.",
    ),
    [],
  );
});

Deno.test("mere: a release commit is a bare subject", () => {
  assertEquals(v("mere", "Release 0.24.0"), []);
  assertEquals(
    v("mere", "Release 0.24.0\n\nSee the changelog.").join("|").includes(
      "must not have a body",
    ),
    true,
  );
});

Deno.test("mere: status claims in a body are refused", () => {
  for (
    const claim of [
      "All tests pass.",
      "Tests now pass on both architectures.",
      "Built and tested locally.",
      "CI passed.",
      "Generated with Claude Code",
    ]
  ) {
    const violations = v(
      "mere",
      `Fix a leak\n\nThe buffer was not freed. ${claim}`,
    );
    assertEquals(
      violations.some((x) => x.includes("the pipeline reports that")),
      true,
      claim,
    );
  }
});

Deno.test("mere: explaining a test is not a status claim", () => {
  assertEquals(
    v(
      "mere",
      "Fix a leak\n\nAdd a test that fails if the buffer is not freed, so the leak cannot return.",
    ),
    [],
  );
});

Deno.test("mere: trailers are refused", () => {
  assertEquals(
    v("mere", "Fix a leak\n\nWhy.\n\nCo-authored-by: A <a@b.c>").some((x) =>
      x.includes("trailer")
    ),
    true,
  );
});

Deno.test("merelinux: a bump is a bare subject; a new package may add a line", () => {
  assertEquals(v("merelinux", "core/skalibs: Bump release to 2"), []);
  assertEquals(v("merelinux", "jq: upgrade to 1.8.2"), []);
  assertEquals(
    v("merelinux", "jq: upgrade to 1.8.2\n\nBecause.").some((x) =>
      x.includes("must not have a body")
    ),
    true,
  );
  assertEquals(
    v("merelinux", "jq: Upgrade to 1.8.2\n\nBecause.").some((x) =>
      x.includes("must not have a body")
    ),
    true,
  );
  assertEquals(
    v("merelinux", "Add nasm at 3.01\n\nx86 assembler. Required by limine."),
    [],
  );
});

Deno.test("title, branch and subject length are checked per profile", () => {
  const long = "x".repeat(70);
  assertEquals(
    v("merelinux", long).some((x) => x.includes("limit is 69")),
    true,
  );
  assertEquals(v("mere", long), []);
  assertEquals(
    v("mere", "Fix a leak", { title: "Other", branch: "Bad/Branch" }).length,
    2,
  );
  assertEquals(v("mere", "Fix a leak", { branch: "fix-a-leak" }), []);
});

Deno.test("an associated issue must be cited in the PR body", () => {
  const check = (prBody: string | undefined) =>
    v("mere", "Fix a leak", { issue: 42, prBody });
  assertEquals(check("Fixes #42"), []);
  assertEquals(check("Closes #42.\n"), []);
  assertEquals(check("Fixes #420").length, 1);
  assertEquals(check("No reference").length, 1);
  assertEquals(check(undefined).length, 1);
  assertEquals(v("mere", "Fix a leak", { prBody: "anything" }), []);
});

Deno.test("an existing commit is parsed with its author", () => {
  assertEquals(parseRawCommit("Ann <a@example.com>\nFix a leak\n"), {
    authorName: "Ann",
    authorEmail: "a@example.com",
    message: "Fix a leak",
  });
  assertEquals(parseRawCommit("no newline"), undefined);
  assertEquals(
    checkCommit(
      { message: "Fix a leak", authorEmail: "x@example.com" },
      PROFILES.mere,
      { authorEmail: "a@example.com" },
    ).length,
    1,
  );
});
