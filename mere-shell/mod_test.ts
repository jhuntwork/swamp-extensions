import {
  assertEquals,
  assertFalse,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  ensureRoot,
  model,
  parseSHA256SUMS,
  isExposedPath,
  requireReachableWorkdir,
  resolveMereRoot,
  runCommand,
  sha256Hex,
  truncate,
} from "./mod.ts";

Deno.test("package names reject profile syntax injection", () => {
  assertThrows(
    () =>
      model.methods.run.arguments.parse({
        packages: ["safe-package\"\n profile {"],
        argv: ["mere", "describe"],
      }),
    Error,
    "package names",
  );
});

Deno.test("resolveMereRoot selects the host root without a symlink", () => {
  assertEquals(resolveMereRoot("", true), "/");
  assertEquals(resolveMereRoot("/", true), "/");
  assertEquals(resolveMereRoot("/tmp/mere-root", false), "/tmp/mere-root");
  assertEquals(resolveMereRoot("", false, "/repo/.swamp/mere-shell/root"), "/repo/.swamp/mere-shell/root");
  assertEquals(resolveMereRoot("/tmp/mere-root", false, "/repo/default"), "/tmp/mere-root");
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

Deno.test("only directories the shell shares with the host are reachable", () => {
  for (const path of ["/home/u/work", "/var/tmp/x", "/run/user/1000", "/home"]) {
    assertEquals(isExposedPath(path), true, path);
  }
  for (const path of ["/tmp/work", "/tmpfoo", "/homework", "/mnt/x", "/"]) {
    assertEquals(isExposedPath(path), false, path);
  }
});

Deno.test("an unreachable working directory is refused with the reason", async () => {
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "workdir-" });
  try {
    await assertRejects(
      () => requireReachableWorkdir(dir),
      Error,
      "/tmp is a private tmpfs",
    );
  } finally {
    await Deno.remove(dir);
  }
});

Deno.test("a missing, relative, or non-directory working directory is refused", async () => {
  await assertRejects(() => requireReachableWorkdir("relative/path"), Error, "absolute");
  await assertRejects(
    () => requireReachableWorkdir("/home/does-not-exist-xyz"),
    Error,
    "not usable",
  );
  const home = Deno.env.get("HOME") ?? "";
  const file = await Deno.makeTempFile({ dir: home, prefix: ".workdir-file-" });
  try {
    await assertRejects(() => requireReachableWorkdir(file), Error, "not a directory");
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("a symlink into /tmp is judged by where it points", async () => {
  const home = Deno.env.get("HOME") ?? "";
  const target = await Deno.makeTempDir({ dir: "/tmp", prefix: "workdir-" });
  const link = `${home}/.workdir-link-${crypto.randomUUID()}`;
  await Deno.symlink(target, link);
  try {
    await assertRejects(() => requireReachableWorkdir(link), Error, "private tmpfs");
  } finally {
    await Deno.remove(link);
    await Deno.remove(target);
  }
});

Deno.test("a directory under the home is accepted", async () => {
  const home = Deno.env.get("HOME") ?? "";
  const dir = await Deno.makeTempDir({ dir: home, prefix: ".workdir-ok-" });
  try {
    await requireReachableWorkdir(dir);
  } finally {
    await Deno.remove(dir);
  }
});
