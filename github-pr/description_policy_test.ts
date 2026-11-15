import { assertEquals } from "jsr:@std/assert@1.0.19";
import {
  checkPullRequestDescription,
  requirePullRequestDescription,
} from "./description_policy.ts";

Deno.test("the description policy accepts an empty body", () => {
  assertEquals(checkPullRequestDescription(""), []);
  requirePullRequestDescription("");
});

Deno.test("the description policy accepts arbitrary body content", () => {
  const bodies = [
    "# Heading\n\n- a list\n\ntext",
    "text\n```\ncode\n```",
    "x".repeat(4_001),
    "first\n\nsecond\n\nthird",
  ];
  for (const body of bodies) {
    assertEquals(checkPullRequestDescription(body), [], body);
    requirePullRequestDescription(body);
  }
});

Deno.test("the legacy style argument does not impose formatting rules", () => {
  assertEquals(
    checkPullRequestDescription("# heading\n\n- item", "paragraph"),
    [],
  );
  assertEquals(
    checkPullRequestDescription("```\ncode\n```", "markdown"),
    [],
  );
});

Deno.test("requirePullRequestDescription accepts the supplied content unchanged", () => {
  requirePullRequestDescription("unchanged");
  assertEquals(checkPullRequestDescription("unchanged"), []);
});
