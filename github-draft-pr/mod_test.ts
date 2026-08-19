import { assertEquals } from "jsr:@std/assert@1.0.19";
import { model } from "./mod.ts";

Deno.test("model exposes the stable draft-PR contract", () => {
  assertEquals(model.type, "@jeremy/github-draft-pr");
  assertEquals(model.version, "2026.08.18.1");
  assertEquals(Object.keys(model.resources).sort(), [
    "applied",
    "plan",
    "preflight",
    "verification",
  ]);
  assertEquals(Object.keys(model.methods).sort(), [
    "applyDraft",
    "planDraft",
    "preflight",
    "verifyDraft",
  ]);
});
