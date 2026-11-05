import { assertEquals } from "jsr:@std/assert@1";
import {
  fixedArgv,
  isWithinSourceRoot,
  resultIdentity,
  truncate,
} from "../tree.ts";

Deno.test("source paths stay inside the repository Mere worktree root", () => {
  assertEquals(
    isWithinSourceRoot("/repo/.swamp/mere", "/repo/.swamp/mere/worktree"),
    true,
  );
  assertEquals(
    isWithinSourceRoot("/repo/.swamp/mere", "/repo/.swamp/mere"),
    false,
  );
  assertEquals(
    isWithinSourceRoot("/repo/.swamp/mere", "/repo/.swamp/mere/../other"),
    false,
  );
  assertEquals(
    isWithinSourceRoot("/repo/.swamp/mere", "/repo/.swamp/mere-other"),
    false,
  );
});
Deno.test("fixedArgv keeps package-manager validation commands bounded", () => {
  assertEquals(fixedArgv("fmtCheck"), [
    "zig",
    "fmt",
    "--check",
    "src",
    "build.zig",
    "build.zig.zon",
  ]);
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
  assertEquals(resultIdentity("fmtCheck"), "fmt-result");
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
