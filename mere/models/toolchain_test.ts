import { assertEquals, assertRejects } from "./_lib/assert_test.ts";
import { assertIsolatedRoot, ensureRoot, rootState } from "./_lib/root.ts";
import { installBinary, resolvePaths, sha256File } from "../toolchain.ts";
import { join } from "node:path";

const FAKE_MERE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "mere 0.23.0"; exit 0; fi
if [ "$1" = "--root" ] && [ "$3" = "store" ] && [ "$4" = "init" ]; then
  mkdir -p "$2/mere/store"; exit 0
fi
echo "unexpected: $*" >&2; exit 2
`;

async function fakeBinary(dir: string) {
  const path = join(dir, "fake-mere");
  await Deno.writeTextFile(path, FAKE_MERE);
  return { path, sha: await sha256File(path) };
}

Deno.test("paths derive from the repo and reject host roots", () => {
  const paths = resolvePaths("/repo", "mere-0230", {
    mereVersion: "0.23.0",
    mereRoot: "",
  }, "x86_64");
  assertEquals(paths.root, "/repo/.swamp/mere/mere-0230/root");
  assertEquals(
    paths.binaryPath,
    "/repo/.swamp/mere/mere-0230/bin/mere-0.23.0-x86_64",
  );
  for (const bad of ["/", "/mere", "/mere/x", "relative/path"]) {
    let threw = false;
    try {
      assertIsolatedRoot(bad);
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  }
});

Deno.test("installBinary verifies the digest, installs executable, is idempotent", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { path, sha } = await fakeBinary(dir);
    const destination = join(dir, "bin", "mere-0.23.0-x86_64");
    await assertRejects(
      () => installBinary(path, "0".repeat(64), destination),
      Error,
      "mismatch",
    );
    const first = await installBinary(path, sha, destination);
    assertEquals(first.reused, false);
    assertEquals(((await Deno.stat(destination)).mode! & 0o111) !== 0, true);
    const second = await installBinary(path, sha, destination);
    assertEquals(second.reused, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureRoot initialises store, config and key once", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { path } = await fakeBinary(dir);
    await Deno.chmod(path, 0o755);
    const root = join(dir, "root");
    let calls = 0;
    const fetcher: typeof fetch = (input) => {
      calls++;
      return Promise.resolve(new Response(`content of ${input}`));
    };
    const options = {
      binary: path,
      root,
      configUrl: "https://example.org/config.kdl",
      publicKeyUrl: "https://example.org/mere.pub",
      signal: new AbortController().signal,
      fetcher,
    };
    const state = await ensureRoot(options);
    assertEquals(state, {
      storePresent: true,
      configPresent: true,
      keyPresent: true,
    });
    assertEquals(calls, 2);
    await ensureRoot(options);
    assertEquals(calls, 2);
    assertEquals(
      await Deno.readTextFile(join(root, "mere", "config.kdl")),
      "content of https://example.org/config.kdl",
    );
    assertEquals((await rootState(root)).keyPresent, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureRoot throws when config cannot be fetched", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { path } = await fakeBinary(dir);
    await Deno.chmod(path, 0o755);
    await assertRejects(
      () =>
        ensureRoot({
          binary: path,
          root: join(dir, "root"),
          configUrl: "https://example.org/config.kdl",
          publicKeyUrl: "https://example.org/mere.pub",
          signal: new AbortController().signal,
          fetcher: () => Promise.resolve(new Response("no", { status: 404 })),
        }),
      Error,
      "HTTP 404",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
