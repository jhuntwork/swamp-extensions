import { z } from "npm:zod@4.1.12";
import { blake3 } from "npm:@noble/hashes@2.0.1/blake3.js";
import { join } from "node:path";

const FetchHashArgs = z.object({ url: z.string().url() });
const ArtifactSchema = z.object({
  url: z.string(),
  path: z.string(),
  blake3: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  arch: z.string(),
  os: z.string(),
  durationMs: z.number().nonnegative(),
});

export async function downloadArtifact(
  url: string,
  directory: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  if (new URL(url).protocol !== "https:") {
    throw new Error("Source URL must use HTTPS");
  }
  signal.throwIfAborted();
  const started = performance.now();
  await Deno.mkdir(directory, { recursive: true });
  const response = await fetcher(url, { signal, redirect: "error" });
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
    const digest = Array.from(
      hash.digest(),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    file.close();
    const path = join(directory, digest);
    await Deno.rename(temporary, path);
    return {
      url,
      path,
      blake3: digest,
      bytes,
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
        "Download an HTTPS source and compute BLAKE3 without shell commands. Redirects are refused in this initial draft.",
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
        const urlDigest = Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(args.url),
            ),
          ),
          (b) => b.toString(16).padStart(2, "0"),
        ).join("");
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
