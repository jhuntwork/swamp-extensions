import { treeDigest, verifyProviderExtension } from "./pi_extension_pin.ts";

function assert(value: unknown): asserts value {
  if (!value) throw new Error("assertion failed");
}
async function refuses(work: () => Promise<unknown>, reason: string) {
  try {
    await work();
  } catch (error) {
    assert(error instanceof Error && error.message === reason);
    return;
  }
  throw new Error("expected refusal: " + reason);
}

async function tree(files: Record<string, string>) {
  const root = await Deno.makeTempDir({ prefix: "pin-test-" });
  for (const [name, text] of Object.entries(files)) {
    const path = `${root}/${name}`;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
  return root;
}
const base = {
  "extensions/kiro.ts": "import '../src/provider.ts'",
  "src/provider.ts": "export const a = 1",
  "package.json": "{}",
};

Deno.test("the digest is stable and ignores .git, tests and the lock file", async () => {
  const a = await tree(base);
  const b = await tree({
    ...base,
    "tests/x.ts": "ignored",
    ".git/HEAD": "ignored",
    "package-lock.json": "ignored",
  });
  assert((await treeDigest(a)).digest === (await treeDigest(b)).digest);
  assert(
    (await treeDigest(a)).files.join() ===
      "extensions/kiro.ts,package.json,src/provider.ts",
  );
});

Deno.test("a matching digest returns the absolute entry path", async () => {
  const root = await tree(base);
  const { digest } = await treeDigest(root);
  const path = await verifyProviderExtension({
    root,
    entry: "extensions/kiro.ts",
    digest,
  });
  assert(path === `${root}/extensions/kiro.ts`);
});

Deno.test("changing a file the entry imports is detected, not only the entry", async () => {
  const root = await tree(base);
  const { digest } = await treeDigest(root);
  await Deno.writeTextFile(`${root}/src/provider.ts`, "export const a = 2");
  await refuses(
    () =>
      verifyProviderExtension({ root, entry: "extensions/kiro.ts", digest }),
    "pi-extension-digest-mismatch",
  );
});

Deno.test("an added or removed file is detected", async () => {
  const root = await tree(base);
  const { digest } = await treeDigest(root);
  await Deno.writeTextFile(`${root}/src/extra.ts`, "x");
  await refuses(
    () =>
      verifyProviderExtension({ root, entry: "extensions/kiro.ts", digest }),
    "pi-extension-digest-mismatch",
  );
  await Deno.remove(`${root}/src/extra.ts`);
  await Deno.remove(`${root}/src/provider.ts`);
  await refuses(
    () =>
      verifyProviderExtension({ root, entry: "extensions/kiro.ts", digest }),
    "pi-extension-digest-mismatch",
  );
});

Deno.test("a symlink anywhere in the tree is refused", async () => {
  const root = await tree(base);
  await Deno.symlink("/etc/passwd", `${root}/src/link.ts`);
  await refuses(() => treeDigest(root), "pi-extension-symlink");
  const top = await tree(base);
  await Deno.symlink("/tmp", `${top}/linked-dir`);
  await refuses(() => treeDigest(top), "pi-extension-symlink");
});

Deno.test("an entry outside the tree, or not in it, is refused", async () => {
  const root = await tree(base);
  const { digest } = await treeDigest(root);
  for (
    const entry of [
      "../kiro.ts",
      "/etc/passwd",
      "extensions/../x.ts",
      "",
      "a b.ts",
    ]
  ) {
    await refuses(
      () => verifyProviderExtension({ root, entry, digest }),
      "pi-extension-bad-entry",
    );
  }
  await refuses(
    () =>
      verifyProviderExtension({ root, entry: "extensions/missing.ts", digest }),
    "pi-extension-entry-missing",
  );
});

Deno.test("an unsafe root or a malformed digest is refused", async () => {
  const root = await tree(base);
  for (const bad of ["relative/dir", "/tmp/../etc", "/tmp/a b", "/tmp/$(x)"]) {
    await refuses(
      () =>
        verifyProviderExtension({
          root: bad,
          entry: "e.ts",
          digest: "0".repeat(64),
        }),
      "pi-extension-bad-root",
    );
  }
  await refuses(
    () =>
      verifyProviderExtension({
        root,
        entry: "extensions/kiro.ts",
        digest: "nothex",
      }),
    "pi-extension-bad-digest",
  );
});

Deno.test("an unsafe file name or an oversized tree is refused", async () => {
  const root = await tree({ ...base, "src/we ird.ts": "x" });
  await refuses(() => treeDigest(root), "pi-extension-bad-name");
  const big = await tree({
    ...base,
    "src/big.ts": "x".repeat(2 * 1024 * 1024 + 1),
  });
  await refuses(() => treeDigest(big), "pi-extension-too-large");
});
