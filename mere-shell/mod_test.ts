import { assertEquals, assertFalse, assertThrows } from "jsr:@std/assert@1";
import {
  ensureRoot,
  parseSHA256SUMS,
  resolveMereRoot,
  runCommand,
  sha256Hex,
  truncate,
} from "./mod.ts";

Deno.test("resolveMereRoot selects the host root without a symlink", () => {
  assertEquals(resolveMereRoot("", true), "/");
  assertEquals(resolveMereRoot("/", true), "/");
  assertEquals(resolveMereRoot("/tmp/mere-root", false), "/tmp/mere-root");
  assertThrows(
    () => resolveMereRoot("/tmp/mere-root", true),
    Error,
    "requires mereRoot to be empty or '/'",
  );
});

Deno.test({
  name: "ensureRoot repairs a legacy host-store symlink",
  permissions: { read: true, write: true, run: true },
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "mere-shell-test-" });
    try {
      await Deno.mkdir(`${root}/mere/keys`, { recursive: true });
      await Deno.writeTextFile(`${root}/mere/config.kdl`, "config {}\n");
      await Deno.writeTextFile(`${root}/mere/keys/mere.pub`, "test-key\n");
      await Deno.symlink("/mere/store", `${root}/mere/store`);

      const fakeMere = `${root}/fake-mere.sh`;
      await Deno.writeTextFile(
        fakeMere,
        '#!/bin/sh\nmkdir -p "$2/mere/store"\n',
      );
      await Deno.chmod(fakeMere, 0o755);

      await ensureRoot(root, fakeMere);

      const store = await Deno.lstat(`${root}/mere/store`);
      assertFalse(store.isSymlink);
      assertEquals(store.isDirectory, true);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
Deno.test("parseSHA256SUMS finds an architecture-specific digest", () => {
  const sums = `${"a".repeat(64)}  mere-0.18.2-linux-x86_64\n${
    "b".repeat(64)
  } *mere-0.18.2-linux-aarch64\n`;
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

Deno.test("truncate declares whether output was capped", () => {
  assertEquals(truncate("abc", 3), { text: "abc", truncated: false });
  assertEquals(truncate("abcd", 3), {
    text: "abc\n... [truncated]",
    truncated: true,
  });
});

Deno.test({
  name: "runCommand aborts a controlled child process",
  permissions: { run: true },
  async fn() {
    const controller = new AbortController();
    const pending = runCommand(Deno.execPath(), {
      args: [
        "eval",
        "await new Promise((resolve) => setTimeout(resolve, 10_000))",
      ],
      stdout: "piped",
      stderr: "piped",
    }, controller.signal);
    setTimeout(() => controller.abort(), 25);
    const output = await pending;
    assertEquals(output.success, false);
  },
});
