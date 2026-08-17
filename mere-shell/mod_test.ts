import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { parseSHA256SUMS, runCommand, sha256Hex } from "./mod.ts";

Deno.test("parseSHA256SUMS finds an architecture-specific digest", () => {
  const sums = `${"a".repeat(64)}  mere-0.18.2-linux-x86_64\n${"b".repeat(64)} *mere-0.18.2-linux-aarch64\n`;
  assertEquals(
    parseSHA256SUMS(sums, "mere-0.18.2-linux-aarch64"),
    "b".repeat(64),
  );
});

Deno.test("parseSHA256SUMS rejects a missing binary", () => {
  assertThrows(
    () => parseSHA256SUMS(`${"a".repeat(64)}  other\n`, "missing"),
    Error,
    "does not contain",
  );
});

Deno.test("sha256Hex produces the canonical digest", async () => {
  assertEquals(
    await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test({
  name: "runCommand aborts a controlled child process",
  permissions: { run: true },
  async fn() {
    const controller = new AbortController();
    const pending = runCommand(Deno.execPath(), {
      args: ["eval", "await new Promise((resolve) => setTimeout(resolve, 10_000))"],
      stdout: "piped",
      stderr: "piped",
    }, controller.signal);
    setTimeout(() => controller.abort(), 25);
    const output = await pending;
    assertEquals(output.success, false);
  },
});
