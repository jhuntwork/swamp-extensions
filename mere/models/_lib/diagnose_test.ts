import { assertEquals } from "./assert_test.ts";
import { diagnose } from "../recipe.ts";

Deno.test("diagnose finds the failing phase and mere's error", () => {
  const tail = `prepare inih-62
  fetch sources
    error https://x/y.tar.gz
error prepare failed
  error: failed to download recipe sources: "u" - blake3 mismatch; expected=00 actual=ab`;
  assertEquals(diagnose(tail), {
    failingPhase: "prepare",
    errorLine:
      'error: failed to download recipe sources: "u" - blake3 mismatch; expected=00 actual=ab',
  });
  assertEquals(diagnose("build x\n  something odd\n").failingPhase, "");
  assertEquals(diagnose("").errorLine, "");
});
