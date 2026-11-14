import { assertEquals } from "jsr:@std/assert@1.0.19";
import {
  checkDescriptionContext,
  renderMaintainerContext,
} from "./description_context.ts";
import { checkPullRequestDescription } from "./description_policy.ts";

Deno.test("rejects operator reassurance and execution status", () => {
  for (
    const body of [
      "No host installation or kernel changes.",
      "Built locally; 861 tests passed.",
    ]
  ) {
    assertEquals(checkPullRequestDescription(body).length > 0, true, body);
  }
});

Deno.test("keeps relevant technical context and focused evidence", () => {
  for (
    const body of [
      "Recipe-build namespaces retain their existing mount policy.",
      "A non-recursive bind excludes writable sysfs child mounts.",
      "The regression test verifies writes fail with EROFS.",
      "Fix CI builds failing to locate shaderc.",
    ]
  ) {
    assertEquals(checkPullRequestDescription(body), [], body);
  }
});

Deno.test("explicit none and optional policies allow intentional empty bodies", () => {
  assertEquals(checkPullRequestDescription("", "paragraph"), [
    "the description is empty",
  ]);
  assertEquals(checkPullRequestDescription("", "paragraph", true), []);
  assertEquals(checkDescriptionContext("", undefined, "none"), []);
  assertEquals(checkDescriptionContext("", undefined, "optional"), []);
  assertEquals(
    checkDescriptionContext("Unnecessary text.", undefined, "none"),
    ["description policy 'none' requires an empty description"],
  );
  assertEquals(
    checkDescriptionContext(
      "",
      { kind: "upstream", summary: "Release notes" },
      "none",
    ),
    ["description policy 'none' does not accept maintainer context"],
  );
});
Deno.test("renders and binds structured maintainer context to the exact body", () => {
  const context = {
    kind: "change" as const,
    problem: "Shell GPU discovery cannot see the device sysfs tree.",
    rationale: "Expose sysfs only in interactive shells with a read-only bind.",
    consequences: "Recipe-build namespaces retain their existing mount policy.",
    verification: "The regression test verifies writes fail with EROFS.",
  };
  const body = renderMaintainerContext(context);
  assertEquals(checkDescriptionContext(body, context, "maintainer"), []);
  assertEquals(
    checkDescriptionContext(
      `${body} No host installation or kernel changes.`,
      context,
      "maintainer",
    ).length > 0,
    true,
  );
});
