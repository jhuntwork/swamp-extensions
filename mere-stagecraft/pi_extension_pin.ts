/** Pins the one provider extension a snapshot Pi run may load. @module */
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const LIMITS = {
  files: 200,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
};

/** An extension directory, its entry file inside it, and the digest it must have. */
export type ProviderExtension = { root: string; entry: string; digest: string };

function hex(bytes: ArrayBuffer): string {
  return Array.from(
    new Uint8Array(bytes),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

function checkRoot(root: string) {
  if (
    !root.startsWith("/") || !SAFE_PATH.test(root) ||
    root.split("/").includes("..")
  ) {
    throw new Error("pi-extension-bad-root");
  }
}

function checkEntry(entry: string) {
  if (
    entry.startsWith("/") || !SAFE_PATH.test(entry) ||
    entry.split("/").some((part) =>
      part === ".." || part === "." || part === ""
    )
  ) {
    throw new Error("pi-extension-bad-entry");
  }
}

/**
 * Digest of every regular file under `root`: sha256 of the lines
 * `<relative path>\0<sha256 of file>\n`, sorted by path. The top-level `.git`
 * and `tests` directories and `package-lock.json` are skipped, because Pi does
 * not load them and a package manager may rewrite the lock file. A symlink or
 * special file anywhere, an unsafe file name, or a tree over the limits is refused.
 */
export async function treeDigest(
  root: string,
): Promise<{ digest: string; files: string[] }> {
  checkRoot(root);
  const files: string[] = [];
  async function walk(dir: string, rel: string) {
    for await (const item of Deno.readDir(dir)) {
      const path = `${dir}/${item.name}`;
      const name = rel === "" ? item.name : `${rel}/${item.name}`;
      if (!SAFE_PATH.test(name)) throw new Error("pi-extension-bad-name");
      const info = await Deno.lstat(path);
      if (info.isSymlink) throw new Error("pi-extension-symlink");
      if (info.isDirectory) {
        if (rel === "" && (item.name === ".git" || item.name === "tests")) {
          continue;
        }
        await walk(path, name);
      } else if (info.isFile) {
        if (rel === "" && item.name === "package-lock.json") continue;
        files.push(name);
        if (files.length > LIMITS.files) {
          throw new Error("pi-extension-too-large");
        }
      } else {
        throw new Error("pi-extension-special-file");
      }
    }
  }
  await walk(root, "");
  files.sort();
  let total = 0;
  const lines: string[] = [];
  for (const name of files) {
    const data = await Deno.readFile(`${root}/${name}`);
    total += data.length;
    if (data.length > LIMITS.fileBytes || total > LIMITS.totalBytes) {
      throw new Error("pi-extension-too-large");
    }
    lines.push(
      `${name}\0${hex(await crypto.subtle.digest("SHA-256", data))}\n`,
    );
  }
  const digest = hex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(lines.join("")),
    ),
  );
  return { digest, files };
}

/**
 * Refuse unless the extension tree matches its pinned digest and the entry is
 * part of it. Returns the absolute entry path to hand to Pi. This detects a
 * change since the digest was pinned; it does not stop a process running as the
 * same user from changing the files between this check and Pi loading them.
 */
export async function verifyProviderExtension(
  spec: ProviderExtension,
): Promise<string> {
  checkRoot(spec.root);
  checkEntry(spec.entry);
  if (!/^[a-f0-9]{64}$/.test(spec.digest)) {
    throw new Error("pi-extension-bad-digest");
  }
  const actual = await treeDigest(spec.root);
  if (actual.digest !== spec.digest) {
    throw new Error("pi-extension-digest-mismatch");
  }
  if (!actual.files.includes(spec.entry)) {
    throw new Error("pi-extension-entry-missing");
  }
  return `${spec.root}/${spec.entry}`;
}
