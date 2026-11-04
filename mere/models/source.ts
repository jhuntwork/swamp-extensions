import { z } from "npm:zod@4.1.12";
import { blake3 } from "npm:@noble/hashes@2.0.1/blake3.js";
import { join } from "node:path";

const FetchHashArgs = z.object({ url: z.string().url() });
const ArtifactSchema = z.object({
  url: z.string(),
  resolvedUrl: z.string(),
  path: z.string(),
  blake3: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  cached: z.boolean(),
  arch: z.string(),
  os: z.string(),
  durationMs: z.number().nonnegative(),
});

const MAX_REDIRECTS = 5;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function urlKey(url: string): Promise<string> {
  return hex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)),
    ),
  );
}

function requireHttps(url: string) {
  if (new URL(url).protocol !== "https:") {
    throw new Error("Source URL must use HTTPS");
  }
}

/** Follow redirects by hand so every hop is checked to be HTTPS. */
async function openResponse(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<{ response: Response; resolvedUrl: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    requireHttps(current);
    const response = await fetcher(current, { signal, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      current = new URL(location, current).toString();
      continue;
    }
    return { response, resolvedUrl: current };
  }
  throw new Error(
    `Source download failed: more than ${MAX_REDIRECTS} redirects`,
  );
}

async function hashFile(path: string, signal: AbortSignal) {
  const hash = blake3.create();
  let bytes = 0;
  const file = await Deno.open(path, { read: true });
  try {
    for await (const chunk of file.readable) {
      signal.throwIfAborted();
      hash.update(chunk);
      bytes += chunk.length;
    }
  } catch (error) {
    try {
      file.close();
    } catch { /* The stream may already have closed it. */ }
    throw error;
  }
  return { blake3: hex(hash.digest()), bytes };
}

/** Return the cached artifact for a URL only if its bytes still match. */
async function cachedArtifact(
  url: string,
  directory: string,
  signal: AbortSignal,
) {
  const metaPath = join(directory, "by-url", `${await urlKey(url)}.json`);
  let meta: { blake3: string; resolvedUrl: string };
  try {
    meta = JSON.parse(await Deno.readTextFile(metaPath));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
  if (!/^[a-f0-9]{64}$/.test(meta.blake3)) return undefined;
  const path = join(directory, meta.blake3);
  try {
    const actual = await hashFile(path, signal);
    if (actual.blake3 !== meta.blake3) return undefined;
    return { path, resolvedUrl: meta.resolvedUrl, ...actual };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

export async function downloadArtifact(
  url: string,
  directory: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  requireHttps(url);
  signal.throwIfAborted();
  const started = performance.now();
  await Deno.mkdir(join(directory, "by-url"), { recursive: true });
  const cached = await cachedArtifact(url, directory, signal);
  if (cached) {
    return {
      url,
      resolvedUrl: cached.resolvedUrl,
      path: cached.path,
      blake3: cached.blake3,
      bytes: cached.bytes,
      cached: true,
      arch: Deno.build.arch,
      os: Deno.build.os,
      durationMs: performance.now() - started,
    };
  }
  const { response, resolvedUrl } = await openResponse(url, signal, fetcher);
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Source download failed: HTTP ${response.status}`);
  }
  const temporary = await Deno.makeTempFile({
    dir: directory,
    prefix: "download-",
  });
  const file = await Deno.open(temporary, { write: true });
  let bytes = 0;
  const hash = blake3.create();
  try {
    const reader = response.body.getReader();
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        hash.update(value);
        bytes += value.length;
        let offset = 0;
        while (offset < value.length) {
          offset += await file.write(value.subarray(offset));
        }
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    signal.throwIfAborted();
    const digest = hex(hash.digest());
    file.close();
    const path = join(directory, digest);
    await Deno.rename(temporary, path);
    const metaPath = join(directory, "by-url", `${await urlKey(url)}.json`);
    const metaTemporary = `${metaPath}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(
      metaTemporary,
      JSON.stringify({ blake3: digest, resolvedUrl }),
    );
    await Deno.rename(metaTemporary, metaPath);
    return {
      url,
      resolvedUrl,
      path,
      blake3: digest,
      bytes,
      cached: false,
      arch: Deno.build.arch,
      os: Deno.build.os,
      durationMs: performance.now() - started,
    };
  } catch (error) {
    try {
      file.close();
    } catch { /* Already closed before rename. */ }
    await Deno.remove(temporary).catch((cleanupError) => {
      if (!(cleanupError instanceof Deno.errors.NotFound)) throw cleanupError;
    });
    throw error;
  }
}

export const behavior = {
  type: "@jeremy/mere/source",
  version: "2026.11.04.1",
  description: "Mere upstream source artifacts. Draft: fetchHash only.",
  globalArguments: z.object({}),
  resources: {
    artifact: {
      description: "Downloaded source and its BLAKE3 digest",
      schema: ArtifactSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    fetchHash: {
      description:
        "Download an HTTPS source and compute BLAKE3 without shell commands. HTTPS redirects are followed (max 5); a verified cache is reused by URL.",
      // Read: touches only the scratch download cache, no tracked or remote state.
      kind: "read",
      arguments: FetchHashArgs,
      execute: async (args: z.infer<typeof FetchHashArgs>, context: {
        repoDir: string;
        signal: AbortSignal;
        writeResource: (
          spec: string,
          name: string,
          data: Record<string, unknown>,
        ) => Promise<{ name: string }>;
      }) => {
        const artifact = await downloadArtifact(
          args.url,
          join(context.repoDir, ".swamp", "mere", "downloads"),
          AbortSignal.any([context.signal, AbortSignal.timeout(300_000)]),
        );
        const urlDigest = await urlKey(args.url);
        const handle = await context.writeResource(
          "artifact",
          `artifact-${urlDigest}`,
          artifact,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
