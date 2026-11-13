import { assertEquals } from "./assert_test.ts";
import {
  checkEntries,
  collapse,
  renderEntries,
  unsafeInBody,
} from "./notes.ts";

const CHANGELOG = `
5.8.4 (2026-09-09)

    * liblzma:

        - lzma_alone_decoder(): Fix an invalid memory access after
          memory allocation has failed. This is tracked as
          GHSA-5qpq-xqfv-j9pg.

5.8.3 (2026-03-31)

        - Fix a buffer overflow in lzma_index_append() (CVE-2026-34743):
`;

Deno.test("collapse joins wrapped lines and trims", () => {
  assertEquals(collapse("  a\n   b\t c  "), "a b c");
});

Deno.test("a quote wrapped differently in the file still matches", () => {
  assertEquals(
    checkEntries(CHANGELOG, [{
      version: "5.8.4",
      quote:
        "lzma_alone_decoder(): Fix an invalid memory access after memory allocation has failed.",
    }]),
    [],
  );
});

Deno.test("a reworded quote is refused, and so is one with a changed word", () => {
  const problems = checkEntries(CHANGELOG, [
    {
      version: "5.8.4",
      quote: "Fixes an invalid memory access in the decoder",
    },
    {
      version: "5.8.3",
      quote: "Fix a buffer overrun in lzma_index_append() (CVE-2026-34743):",
    },
  ]);
  assertEquals(problems.length, 2);
  assertEquals(
    problems[0].startsWith("entry 1 (5.8.4) is not in the changelog"),
    true,
  );
  assertEquals(problems[1].startsWith("entry 2 (5.8.3)"), true);
});

Deno.test("quotes that would mention a user, link an issue, or open a fence are refused", () => {
  assertEquals(
    unsafeInBody("Reported by @someone on the list"),
    "contains an @mention, which would notify that user",
  );
  assertEquals(
    unsafeInBody("Fixes #1234 upstream"),
    "contains an issue reference, which would link an unrelated issue",
  );
  assertEquals(unsafeInBody("see ```code```"), "contains a code fence");
  // Emails and version-like text are not mentions or issue links.
  assertEquals(
    unsafeInBody("Reported by Ze <jason@users.noreply.github.com>"),
    undefined,
  );
  assertEquals(unsafeInBody("Fixed CVE-2026-34757 in 1.6.57"), undefined);
});

Deno.test("an unsafe quote that is in the changelog is still refused", () => {
  const log = "Thanks to @someone for the report of this bug.";
  const problems = checkEntries(log, [{
    version: "1.0",
    quote: "Thanks to @someone for the report of this bug.",
  }]);
  assertEquals(problems, [
    "entry 1 (1.0) contains an @mention, which would notify that user",
  ]);
});

Deno.test("entries render grouped by version, in order, one bullet per quote", () => {
  assertEquals(
    renderEntries([
      { version: "5.8.4", quote: "First\n  fix." },
      { version: "5.8.4", quote: "Second fix." },
      { version: "5.8.3", quote: "Older fix." },
    ]),
    "5.8.4:\n\n- First fix.\n- Second fix.\n\n5.8.3:\n\n- Older fix.",
  );
});

Deno.test("cross-repository and GH- issue references are refused too", () => {
  const refused =
    "contains an issue reference, which would link an unrelated issue";
  assertEquals(unsafeInBody("Fixes owner/repo#123 upstream"), refused);
  assertEquals(unsafeInBody("See GH-45 for details"), refused);
  // A URL fragment or a colour code is not an issue reference.
  assertEquals(unsafeInBody("see https://x.test/page#12"), undefined);
  assertEquals(
    unsafeInBody("see https://github.com/o/r/issues/45 for the report"),
    "links a GitHub issue or pull request, which would cross-reference it",
  );
  assertEquals(
    unsafeInBody("merged in https://github.com/o/r/pull/9"),
    "links a GitHub issue or pull request, which would cross-reference it",
  );
  assertEquals(
    unsafeInBody("see https://github.com/o/r/releases/tag/v1"),
    undefined,
  );
});
