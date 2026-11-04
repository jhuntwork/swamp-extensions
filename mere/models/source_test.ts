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
    assertEquals(entries, ["by-url"]);
    for await (const entry of Deno.readDir(`${dir}/by-url`)) {
      throw new Error(`unexpected cache entry ${entry.name}`);
    }
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

Deno.test("source follows HTTPS redirects and refuses downgrade", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const fetcher: typeof fetch = (input) => {
      const url = String(input);
      if (url === "https://example.org/a") {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://cdn.example.org/b" },
          }),
        );
      }
      if (url === "https://cdn.example.org/b") {
        return Promise.resolve(new Response("abc"));
      }
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "http://evil.example.org/c" },
        }),
      );
    };
    const signal = new AbortController().signal;
    const result = await downloadArtifact(
      "https://example.org/a",
      dir,
      signal,
      fetcher,
    );
    assertEquals(result.resolvedUrl, "https://cdn.example.org/b");
    assertEquals(result.bytes, 3);
    await assertRejects(
      () => downloadArtifact("https://example.org/z", dir, signal, fetcher),
      Error,
      "HTTPS",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("source reuses a verified cache and re-downloads a corrupted one", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let calls = 0;
    const fetcher: typeof fetch = () => {
      calls++;
      return Promise.resolve(new Response("abc"));
    };
    const signal = new AbortController().signal;
    const url = "https://example.org/source";
    const first = await downloadArtifact(url, dir, signal, fetcher);
    assertEquals(first.cached, false);
    const second = await downloadArtifact(url, dir, signal, fetcher);
    assertEquals(second.cached, true);
    assertEquals(second.blake3, first.blake3);
    assertEquals(calls, 1);
    await Deno.writeTextFile(first.path, "tampered");
    const third = await downloadArtifact(url, dir, signal, fetcher);
    assertEquals(third.cached, false);
    assertEquals(await Deno.readTextFile(third.path), "abc");
    assertEquals(calls, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
