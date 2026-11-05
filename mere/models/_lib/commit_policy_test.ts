import { assertEquals } from "./assert_test.ts";
import { checkCommit, DEFAULT_RULES, parseRawCommit } from "./commit_policy.ts";

const rules = {
  ...DEFAULT_RULES,
  subjectPattern: "^[a-z0-9][a-z0-9._+-]*: [a-z0-9].*$",
  branchPattern: "^bump-[a-z0-9._-]+$",
};

Deno.test("a conforming bump commit has no violations", () => {
  assertEquals(
    checkCommit(
      {
        message: "jq: upgrade to 1.8.2\n",
        title: "jq: upgrade to 1.8.2",
        branch: "bump-jq-1.8.2",
      },
      rules,
      { subject: "jq: upgrade to 1.8.2" },
    ),
    [],
  );
});

Deno.test("each rule reports its own violation", () => {
  const v = (message: string, extra = {}) =>
    checkCommit({ message, ...extra }, rules).join(" | ");
  assertEquals(v("").includes("empty"), true);
  assertEquals(v("x".repeat(70) + ": y").includes("limit is 69"), true);
  assertEquals(v("jq: upgrade to 1.8.2.").includes("period"), true);
  assertEquals(v("Upgrade jq to 1.8.2").includes("does not match"), true);
  assertEquals(v(" jq: upgrade").includes("whitespace"), true);
  assertEquals(
    v("jq: upgrade to 1\n\nSome details").includes("bodies are not allowed"),
    true,
  );
  assertEquals(
    v("jq: upgrade to 1\n\nCo-Authored-By: A <a@b.c>").includes("trailer"),
    true,
  );
  assertEquals(
    v("jq: upgrade to 1", { title: "Upgrade jq" }).includes("differs"),
    true,
  );
  assertEquals(
    v("jq: upgrade to 1", { branch: "feature/x" }).includes("branch"),
    true,
  );
});

Deno.test("with bodies allowed, trailers are still caught and a blank line is required", () => {
  const allow = { ...rules, allowBody: true };
  assertEquals(
    checkCommit({ message: "jq: upgrade to 1\n\nWhy it matters." }, allow),
    [],
  );
  assertEquals(
    checkCommit({ message: "jq: upgrade to 1\nno blank line" }, allow).length,
    1,
  );
  assertEquals(
    checkCommit(
      { message: "jq: upgrade to 1\n\nSigned-off-by: A <a@b.c>" },
      allow,
    ).length,
    1,
  );
  assertEquals(
    checkCommit({ message: "jq: upgrade to 1\n\nSigned-off-by: A <a@b.c>" }, {
      ...allow,
      forbidTrailers: false,
    }),
    [],
  );
});

Deno.test("post-commit expectations compare the real subject and author", () => {
  const raw = parseRawCommit(
    "Jeremy Huntwork <jeremy@merelinux.org>\njq: upgrade to 1.8.2\n\n",
  )!;
  assertEquals(raw.authorEmail, "jeremy@merelinux.org");
  assertEquals(raw.message, "jq: upgrade to 1.8.2");
  assertEquals(
    checkCommit(
      { message: raw.message, authorEmail: raw.authorEmail },
      rules,
      { subject: "jq: upgrade to 1.8.2", authorEmail: "jeremy@merelinux.org" },
    ),
    [],
  );
  const bad = checkCommit(
    { message: "jq: upgrade to 1.8.3", authorEmail: "bot@example.org" },
    rules,
    { subject: "jq: upgrade to 1.8.2", authorEmail: "jeremy@merelinux.org" },
  );
  assertEquals(bad.length, 2);
  assertEquals(parseRawCommit("no newline"), undefined);
  assertEquals(parseRawCommit("garbage\nmessage"), undefined);
});
