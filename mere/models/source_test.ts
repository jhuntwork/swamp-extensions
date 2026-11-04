import { assertEquals, assertRejects } from "./_lib/assert_test.ts";
import { downloadArtifact } from "./source.ts";

Deno.test("source hashes streamed bytes and stores the exact artifact", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const fetcher: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("a"));
              controller.enqueue(new TextEncoder().encode("bc"));
              controller.close();
            },
          }),
        ),
      );
    const result = await downloadArtifact(
      "https://example.org/source",
      dir,
      new AbortController().signal,
      fetcher,
    );
    assertEquals(
      result.blake3,
      "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85",
    );
    assertEquals(result.bytes, 3);
    assertEquals(await Deno.readTextFile(result.path), "abc");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("source removes partial downloads on a stream failure", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const fetcher: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("broken stream"));
            },
          }),
        ),
      );
    await assertRejects(
      () =>
        downloadArtifact(
          "https://example.org/source",
          dir,
          new AbortController().signal,
          fetcher,
        ),
      Error,
      "broken stream",
    );
    const entries = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry.name);
    assertEquals(entries, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("source refuses insecure URLs before any fetch", async () => {
  await assertRejects(
    () =>
      downloadArtifact(
        "http://example.org/source",
        "/unused",
        new AbortController().signal,
      ),
    Error,
    "HTTPS",
  );
});
