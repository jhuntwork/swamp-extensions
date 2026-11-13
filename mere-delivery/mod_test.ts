import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { model, runCheck } from "./mod.ts";
import { PROFILE_NAMES, PROFILES } from "./profiles.ts";

function recorder() {
  const written: Array<{ spec: string; data: Record<string, unknown> }> = [];
  return {
    written,
    context: {
      writeResource: (
        spec: string,
        _name: string,
        data: Record<string, unknown>,
      ) => {
        written.push({ spec, data });
        return Promise.resolve({ name: spec });
      },
    },
  };
}

Deno.test("every profile name has a profile and the reverse", () => {
  assertEquals([...PROFILE_NAMES].sort(), Object.keys(PROFILES).sort());
});

Deno.test("a conforming message is recorded as ok", async () => {
  const { written, context } = recorder();
  await runCheck(
    model.methods.checkCommit.arguments.parse({
      profile: "mere",
      message: "Fix a leak",
    }),
    context,
  );
  assertEquals(written[0].data.ok, true);
});

Deno.test("violations are recorded first and then thrown", async () => {
  const { written, context } = recorder();
  await assertRejects(
    () =>
      runCheck(
        model.methods.checkCommit.arguments.parse({
          profile: "merelinux",
          message: "Fix a leak\n\nA body.\n\nAll tests pass.",
        }),
        context,
      ),
    Error,
    "commit standards (merelinux)",
  );
  assertEquals(written[0].data.ok, false);
});

Deno.test("an unknown profile is rejected before any check", () => {
  assertEquals(
    model.methods.checkCommit.arguments.safeParse({
      profile: "other",
      message: "x",
    }).success,
    false,
  );
});

Deno.test("packaged workflow commits only after the message check and never forces", async () => {
  const text = await Deno.readTextFile(
    new URL("./deliver-change.yaml", import.meta.url),
  );
  const at = (needle: string) => text.indexOf(needle);
  assertEquals(at("name: check-message") < at("name: commit"), true);
  assertEquals(at("name: verify-commit") < at("name: push"), true);
  assertEquals(at("name: assert-scoped") < at("name: plan-pr"), true);
  assertEquals(text.includes("force: false"), true);
  assertEquals(text.includes("force: true"), false);
});

Deno.test("each profile records the PR description style it opts into", async () => {
  for (
    const [profile, style] of [["mere", "paragraph"], ["merelinux", "markdown"]]
  ) {
    const { written, context } = recorder();
    await runCheck(
      model.methods.checkCommit.arguments.parse({
        profile,
        message: "Fix a leak",
      }),
      context,
    );
    assertEquals(written[0].data.descriptionStyle, style, profile);
  }
});
