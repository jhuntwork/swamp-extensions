import { assertEquals } from "jsr:@std/assert@1";
import { fixedArgv, resultIdentity, truncate } from "./mod.ts";

Deno.test("fixedArgv keeps package-manager validation commands bounded", () => {
  assertEquals(fixedArgv("build"), ["zig", "build"]);
  assertEquals(fixedArgv("test"), ["zig", "build", "test", "--summary", "all"]);
  assertEquals(fixedArgv("releaseBuild"), [
    "zig",
    "build",
    "-Doptimize=ReleaseSmall",
    "-Dcpu=baseline",
  ]);
  assertEquals(fixedArgv("smoke"), ["./zig-out/bin/mere", "describe"]);
});

Deno.test("each method has a distinct stable result identity", () => {
  assertEquals(resultIdentity("build"), "build-result");
  assertEquals(resultIdentity("test"), "test-result");
  assertEquals(resultIdentity("releaseBuild"), "baseline-build-result");
  assertEquals(resultIdentity("smoke"), "smoke-result");
});

Deno.test("truncate declares whether bounded output was capped", () => {
  assertEquals(truncate("abc", 3), { text: "abc", truncated: false });
  assertEquals(truncate("abcd", 3), {
    text: "abc\n... [truncated]",
    truncated: true,
  });
});
