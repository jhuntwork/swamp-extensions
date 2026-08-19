import { assertEquals } from "jsr:@std/assert@1.0.19";
import { model } from "./mod.ts";

Deno.test("model exposes the stable PR contract", () => {
  assertEquals(model.type, "@jeremy/github-pr");
  assertEquals(model.version, "2026.08.19.1");
  assertEquals(Object.keys(model.resources).sort(), [
    "applied",
    "plan",
    "preflight",
    "verification",
  ]);
  assertEquals(Object.keys(model.methods).sort(), [
    "applyPr",
    "planPr",
    "preflight",
    "verifyPr",
  ]);
});

// The adapter must not acquire merge, release, or administration authority.
Deno.test("model exposes no merge, release, or administration method", () => {
  const forbidden = ["merge", "release", "admin", "delete", "update", "close"];
  const methods = Object.keys(model.methods).map((name) => name.toLowerCase());
  for (const word of forbidden) {
    assertEquals(
      methods.some((method) => method.includes(word)),
      false,
      `method surface must not include ${word}`,
    );
  }
});
