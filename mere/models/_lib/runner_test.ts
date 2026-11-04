import { assertEquals, assertRejects } from "./assert_test.ts";
import { runCommand } from "./runner.ts";

Deno.test("runner drains both pipes and bounds retained output independently", async () => {
  const result = await runCommand(Deno.execPath(), [
    "eval",
    'await Deno.stdout.write(new TextEncoder().encode("a".repeat(200000) + "OUT")); await Deno.stderr.write(new TextEncoder().encode("b".repeat(200000) + "ERR")); Deno.exit(7);',
  ], { maxOutputBytes: 32 });
  assertEquals(result.exitCode, 7);
  assertEquals(result.stdout, "a".repeat(29) + "OUT");
  assertEquals(result.stderr, "b".repeat(29) + "ERR");
  assertEquals(result.stdoutBytes, 200003);
  assertEquals(result.stderrBytes, 200003);
  assertEquals(result.truncated, true);
});

Deno.test("runner passes argv literally without shell expansion", async () => {
  const literal = "$(echo secret); `echo secret` *";
  const result = await runCommand(Deno.execPath(), [
    "eval",
    "console.log(Deno.args[0])",
    literal,
  ]);
  assertEquals(result.stdout.trim(), literal);
  assertEquals(result.truncated, false);
});

Deno.test("runner rejects an already aborted call before spawning", async () => {
  await assertRejects(
    () =>
      runCommand("does-not-exist", [], {
        signal: AbortSignal.abort(new Error("cancelled")),
      }),
    Error,
    "cancelled",
  );
});

Deno.test("runner cancels a live child after it reports readiness", async () => {
  const directory = await Deno.makeTempDir();
  const ready = `${directory}/ready`;
  const controller = new AbortController();
  const pending = runCommand(Deno.execPath(), [
    "eval",
    `await Deno.writeTextFile(Deno.args[0], "ready"); setInterval(() => {}, 1000); await new Promise(() => {});`,
    ready,
  ], { signal: controller.signal });
  try {
    for (;;) {
      try {
        await Deno.stat(ready);
        break;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort(new Error("cancel live child"));
    await assertRejects(() => pending, Error, "cancel live child");
  } finally {
    controller.abort();
    await pending.catch(() => {});
    await Deno.remove(directory, { recursive: true });
  }
});
