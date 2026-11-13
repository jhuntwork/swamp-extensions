import { join } from "node:path";
import { createHash } from "node:crypto";
import { runCommand } from "./runner.ts";

/** Pull the failing phase and mere's first error out of a build's output tail. */
export function diagnose(
  tail: string,
): { failingPhase: string; errorLine: string } {
  const lines = tail.split("\n");
  let failingPhase = "";
  for (const line of lines) {
    const m = /^error (\S+) failed/.exec(line);
    if (m) failingPhase = m[1];
  }
  const errorLine =
    lines.map((l) => l.trim()).find((l) => l.startsWith("error:")) ??
      lines.map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  return { failingPhase, errorLine: errorLine.slice(0, 400) };
}

/**
 * The directory mere exports a build to: `<name>-<version>-<release>-<arch>`,
 * where mere's own arch is the recipe's `arch` (a list, `any`, or absent, which
 * mere spells `unknown`). Matching the tuple prefix avoids guessing it.
 */
export async function findOutputDir(
  outputsRoot: string,
  tuple: string,
): Promise<string | undefined> {
  const found: string[] = [];
  try {
    for await (const entry of Deno.readDir(outputsRoot)) {
      if (entry.isDirectory && entry.name.startsWith(`${tuple}-`)) {
        found.push(entry.name);
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  if (found.length === 0) return undefined;
  if (found.length > 1) {
    throw new Error(
      `more than one output directory for ${tuple} in ${outputsRoot}: ${
        found.sort().join(", ")
      }`,
    );
  }
  return join(outputsRoot, found[0]);
}

/** Every package archive in a build's output directory, with its hash and size. */
export async function listOutputs(dir: string) {
  const out = [];
  const name = /^(.+)-[^-]+-\d+-[A-Za-z0-9_]+-([0-9a-f]{64})\.pkg\.tar\.zst$/;
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".pkg.tar.zst")) continue;
    const match = name.exec(entry.name);
    const path = join(dir, entry.name);
    out.push({
      fileName: entry.name,
      path,
      package: match ? match[1] : entry.name,
      contentId: match?.[2] ?? "",
      sha256: await sha256OfFile(path),
      bytes: (await Deno.stat(path)).size,
    });
  }
  return out.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await Deno.open(path, { read: true });
  for await (const chunk of file.readable) hash.update(chunk);
  return hash.digest("hex");
}

export function decodeSigningKey(value: string): Uint8Array {
  const compact = value.replace(/\s+/g, "");
  let decoded: string;
  try {
    decoded = atob(compact);
  } catch {
    throw new Error("signingKey must be base64-encoded Mere .key material");
  }
  const bytes = Uint8Array.from(
    decoded,
    (character) => character.charCodeAt(0),
  );
  if (
    bytes.length !== 80 ||
    new TextDecoder().decode(bytes.slice(0, 8)) !== "MEREKEY\0" ||
    bytes[8] !== 1 || bytes[9] !== 2 || bytes[10] !== 1 || bytes[11] !== 0 ||
    new DataView(bytes.buffer, bytes.byteOffset + 12, 4).getUint32(0, true) !==
      64
  ) {
    throw new Error(
      `signingKey must decode to an 80-byte Mere secret key, got ${bytes.length} bytes`,
    );
  }
  return bytes;
}

export function publicKeyFromSigningKey(secret: Uint8Array): Uint8Array {
  const header = new Uint8Array([
    0x4d,
    0x45,
    0x52,
    0x45,
    0x4b,
    0x45,
    0x59,
    0x00,
    0x01,
    0x01,
    0x01,
    0x00,
    0x20,
    0x00,
    0x00,
    0x00,
  ]);
  return Uint8Array.from([...header, ...secret.slice(48)]);
}

export async function removeLegacyRepositoryConfig(
  root: string,
  repository: string,
): Promise<void> {
  const configPath = join(root, "mere", "config.kdl");
  let existing: string;
  try {
    existing = await Deno.readTextFile(configPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  const marker = `repo "${repository}" {`;
  const start = existing.indexOf(marker);
  if (start < 0) return;
  const close = existing.indexOf("}", start);
  if (close < 0) throw new Error(`invalid Mere config: unterminated ${marker}`);
  let begin = start;
  if (begin > 0 && existing[begin - 1] === "\n") begin--;
  let end = close + 1;
  if (existing[end] === "\n") end++;
  await Deno.writeTextFile(
    configPath,
    existing.slice(0, begin) + existing.slice(end),
  );
}

export async function latestBuildLog(
  root: string,
  tuple: string,
  since: number,
) {
  const base = join(root, "mere", "dev", "build");
  let best: { path: string; mtime: number } | undefined;
  try {
    for await (const entry of Deno.readDir(base)) {
      if (!entry.isDirectory || !entry.name.startsWith(`${tuple}-`)) continue;
      const path = join(base, entry.name, "build.log");
      try {
        const mtime = (await Deno.stat(path)).mtime?.getTime() ?? 0;
        // Only a log this build wrote: an older one would mislead.
        if (mtime >= since - 1000 && (!best || mtime > best.mtime)) {
          best = { path, mtime };
        }
      } catch { /* no log in this workspace */ }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return best?.path;
}

export async function removeUninitializedRepository(
  root: string,
  repository: string,
): Promise<void> {
  const repositoryDir = join(root, "mere", "dev", "repo", repository);
  try {
    const database = await Deno.stat(join(repositoryDir, "repo.db"));
    if (database.isFile) return;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await Deno.remove(repositoryDir, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
}

/** Materialize the development key and isolated trust files for build/import. */
export async function prepareSigningKey(
  binary: string,
  root: string,
  encoded: string,
  signal: AbortSignal,
): Promise<{ keyPath: string; home: string; fingerprint: string }> {
  if (!encoded) {
    throw new Error(
      "recipe signingKey is empty; configure the vault-backed development key " +
        "or run the explicit toolchain.generateDevKey procedure first",
    );
  }
  const key = decodeSigningKey(encoded);
  const home = join(root, "home");
  const keyDir = join(home, ".mere", "keys");
  const keyPath = join(keyDir, "mere.key");
  const publicPath = join(keyDir, "mere.pub");
  let wroteKey = false;
  let complete = false;
  try {
    await Deno.mkdir(keyDir, { recursive: true, mode: 0o700 });
    await Deno.writeFile(keyPath, key, { create: true, mode: 0o600 });
    wroteKey = true;
    await Deno.chmod(keyPath, 0o600);
    await Deno.writeFile(publicPath, publicKeyFromSigningKey(key), {
      create: true,
    });
    await Deno.chmod(publicPath, 0o644);
    const fingerprintResult = await runCommand(
      binary,
      ["dev", "key", "fingerprint", publicPath],
      { signal, timeoutMs: 30_000, maxOutputBytes: 4_096 },
    );
    if (fingerprintResult.exitCode !== 0) {
      throw new Error(
        `mere dev key fingerprint failed: ${
          (fingerprintResult.stderr || fingerprintResult.stdout).trim()
        }`,
      );
    }
    const fingerprint = fingerprintResult.stdout.match(/[0-9a-f]{64}/i)?.[0]
      ?.toLowerCase();
    if (!fingerprint) {
      throw new Error("mere returned no development key fingerprint");
    }
    complete = true;
    return { keyPath, home, fingerprint };
  } finally {
    if (wroteKey && !complete) {
      await Deno.remove(keyPath).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
  }
}
