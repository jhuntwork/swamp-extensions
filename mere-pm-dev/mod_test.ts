import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  DEV_PACKAGES,
  fixedArgv,
  model,
  resultIdentity,
  runInShell,
  truncate,
} from "./mod.ts";

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

function fakeContext(
  reply: (options: Record<string, unknown>) => unknown,
  globalArgs: Record<string, unknown> = {},
) {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    context: {
      globalArgs: model.globalArguments.parse(globalArgs),
      runModel: (options: Record<string, unknown>) => {
        calls.push(options);
        return Promise.resolve(reply(options) as never);
      },
      writeResource: () => Promise.resolve({}),
    },
  };
}

Deno.test("commands run in the named mere-shell with the default dev packages", async () => {
  const { calls, context } = fakeContext(() => ({
    ok: true,
    resources: [{
      attributes: {
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        truncated: false,
        success: true,
      },
    }],
  }));
  const result = await runInShell(["zig", "build"], "/work/mere", context);
  assertEquals(result.success, true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].modelType, "@jeremy/mere-shell");
  assertEquals(calls[0].name, "mere-shell-pm");
  assertEquals(calls[0].method, "run");
  assertEquals(calls[0].arguments, {
    packages: [...DEV_PACKAGES],
    argv: ["zig", "build"],
    workdir: "/work/mere",
  });
  assertEquals(DEV_PACKAGES.includes("zig"), true);
});

Deno.test("shell and packages can be overridden per definition", async () => {
  const { calls, context } = fakeContext(
    () => ({
      ok: true,
      resources: [{
        attributes: {
          exitCode: 0,
          stdout: "",
          stderr: "",
          truncated: false,
          success: true,
        },
      }],
    }),
    { shell: "my-shell", packages: ["zig"] },
  );
  await runInShell(["zig", "version"], "/w", context);
  assertEquals(calls[0].name, "my-shell");
  assertEquals((calls[0].arguments as { packages: string[] }).packages, [
    "zig",
  ]);
});

Deno.test("a failed shell call is reported as an error, not a result", async () => {
  const { context } = fakeContext(() => ({
    ok: false,
    error: { message: "pre-flight failed" },
  }));
  await assertRejects(
    () => runInShell(["zig", "build"], "/w", context),
    Error,
    "pre-flight failed",
  );
});

Deno.test("an unavailable runModel is reported, not silently skipped", async () => {
  await assertRejects(
    () =>
      runInShell(["zig", "build"], "/w", {
        globalArgs: model.globalArguments.parse({}),
        writeResource: () => Promise.resolve({}),
      }),
    Error,
    "runModel is unavailable",
  );
});

Deno.test("package names are constrained before they reach the shell", () => {
  assertEquals(
    model.globalArguments.safeParse({ packages: ["zig; rm -rf /"] }).success,
    false,
  );
  assertEquals(
    model.globalArguments.safeParse({ packages: [] }).success,
    false,
  );
});
