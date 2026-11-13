import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import { fixedArgv, model, resultIdentity, truncate } from "./mod.ts";

Deno.test("source paths must be absolute", () => {
  assertThrows(
    () => model.methods.build.arguments.parse({ sourcePath: "relative" }),
    Error,
    "absolute path",
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

Deno.test("packaged delivery workflow checks formatting before the test run", async () => {
  const text = await Deno.readTextFile(
    new URL("./mere-change.yaml", import.meta.url),
  );
  const order = [
    "methodName: fmtCheck",
    "methodName: test",
    "methodName: releaseBuild",
    "methodName: smoke",
  ]
    .map((needle) => text.indexOf(needle));
  assertEquals(order.every((index) => index >= 0), true);
  assertEquals([...order].sort((a, b) => a - b), order);
});

Deno.test("packaged delivery workflow hands the commit and PR to mere-delivery", async () => {
  const text = await Deno.readTextFile(
    new URL("./mere-change.yaml", import.meta.url),
  );
  assertEquals(
    text.includes('workflowIdOrName: "@jeremy/mere-delivery/deliver-change"'),
    true,
  );
  assertEquals(text.includes("profile: mere\n"), true);
  assertEquals(text.includes("repository: jhuntwork/mere\n"), true);
  assertEquals(text.includes("methodName: commit"), false);
  assertEquals(text.includes("methodName: push"), false);
});
