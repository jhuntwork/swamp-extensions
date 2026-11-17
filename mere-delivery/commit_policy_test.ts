import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import {
  checkCommit,
  commitBody,
  IssueActionSchema,
  parseRawCommit,
  preparePullRequestBody,
} from "./commit_policy.ts";
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

Deno.test("mere: a release commit may explain why in a body", () => {
  assertEquals(v("mere", "Release 0.24.0"), []);
  assertEquals(
    v("mere", "Release 0.24.0\n\nThe release includes the activation repair."),
    [],
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

Deno.test("merelinux: a bump or upgrade may carry rationale in the body", () => {
  assertEquals(v("merelinux", "core/skalibs: Bump release to 2"), []);
  assertEquals(v("merelinux", "jq: upgrade to 1.8.2"), []);
  assertEquals(
    v("merelinux", "jq: upgrade to 1.8.2\n\nBecause."),
    [],
  );
  assertEquals(
    v("merelinux", "jq: Upgrade to 1.8.2\n\nBecause."),
    [],
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

Deno.test("the pull request body must match the commit body", () => {
  assertEquals(
    v("mere", "Fix a leak\n\nThe buffer ownership must be explicit.", {
      prBody: "The buffer ownership must be explicit.",
    }),
    [],
  );
  assertEquals(
    v("mere", "Fix a leak\n\nThe buffer ownership must be explicit.", {
      prBody: "# Why\n\nThe caller needs a clear ownership boundary.",
    }).some((x) => x.includes("exactly match the commit body")),
    true,
  );
  assertEquals(commitBody("Fix a leak"), "");
  assertEquals(
    commitBody("Fix a leak\n\nThe buffer ownership must be explicit.\n"),
    "The buffer ownership must be explicit.",
  );
});
Deno.test("issue actions require references in the commit body", () => {
  assertEquals(
    preparePullRequestBody(
      "",
      42,
      "reference",
      "Fix a leak\n\nSee #42",
    ),
    "See #42",
  );
  assertEquals(
    preparePullRequestBody(
      "",
      42,
      "fixes",
      "Fix a leak\n\nFixes #42",
    ),
    "Fixes #42",
  );
  assertThrows(
    () => preparePullRequestBody("", 42, "fixes", "Fix a leak"),
    Error,
    "must contain",
  );
  assertThrows(
    () =>
      preparePullRequestBody("Wrong", 42, "reference", "Fix a leak\n\nSee #42"),
    Error,
    "exactly match",
  );
  assertEquals(IssueActionSchema.safeParse("fixes").success, true);
});

Deno.test("reference action rejects a closing reference", () => {
  assertThrows(
    () =>
      preparePullRequestBody("", 42, "reference", "Fix a leak\n\nFixes #42"),
    Error,
    "conflicts",
  );
});

Deno.test("reference action rejects a closing reference during commit checks", () => {
  assertEquals(
    checkCommit(
      {
        message: "Fix a leak\n\nFixes #42",
        issue: 42,
        issueAction: "reference",
        prBody: "Fixes #42",
      },
      PROFILES.mere,
    ).some((x) => x.includes("commit body contains a closing reference")),
    true,
  );
});

Deno.test("reference mode rejects every closing reference", () => {
  assertEquals(
    v("mere", "Fix a leak\n\nFixes #42", {
      prBody: "Fixes #42",
    }).some((x) => x.includes("closing reference")),
    true,
  );
  assertEquals(
    v("mere", "Fix a leak\n\nFixes #42\n\nRefs #43", {
      issue: 43,
      prBody: "Fixes #42\n\nRefs #43",
    }).some((x) => x.includes("closing reference")),
    true,
  );
});

Deno.test("an associated issue must be cited in the commit body", () => {
  const check = (prBody: string | undefined) =>
    v("mere", `Fix a leak\n\n${prBody ?? ""}`, { issue: 42, prBody });
  assertEquals(check("Refs #42"), []);
  assertEquals(check("Fixes #42").length, 1);
  assertEquals(check("Closes #42.").length, 1);
  assertEquals(check("Fixes #420").length, 2);
  assertEquals(check("No reference").length, 1);
  assertEquals(check(undefined).length, 1);
  assertEquals(check("").length, 1);
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
