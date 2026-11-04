import { assertEquals, assertRejects } from "./assert_test.ts";
import {
  candidateUrl,
  githubRepo,
  isNewer,
  lookupLatest,
  RateLimited,
} from "./upstream.ts";

function fake(routes: Record<string, unknown | Response>): typeof fetch {
  return (input) => {
    const url = String(input);
    const hit = routes[url];
    if (hit === undefined) {
      return Promise.resolve(new Response("nf", { status: 404 }));
    }
    return Promise.resolve(hit instanceof Response ? hit : Response.json(hit));
  };
}

const providers = (fetcher: typeof fetch) => ({
  fetcher,
  anityaBaseUrl: "https://anitya.test",
  signal: new AbortController().signal,
});

const ZLIB = {
  name: "zlib-ng",
  currentVersion: "2.3.3",
  url: "https://github.com/zlib-ng/zlib-ng",
  sourceUrl:
    "https://github.com/zlib-ng/zlib-ng/archive/refs/tags/${recipe.version}.tar.gz",
};

Deno.test("githubRepo reads owner and repo from source or homepage", () => {
  assertEquals(
    githubRepo("https://example.org/x", "https://github.com/a/b.git"),
    {
      owner: "a",
      repo: "b",
    },
  );
  assertEquals(githubRepo("https://gitlab.com/a/b"), undefined);
});

Deno.test("github: newest stable tag, prefix inferred, prereleases skipped", async () => {
  const fetcher = fake({
    "https://api.github.com/repos/zlib-ng/zlib-ng/tags?per_page=100": [
      { name: "2.3.3" },
      { name: "2.4.0-rc1" },
      { name: "2.3.4" },
      { name: "develop" },
      { name: "v9.9.9" },
    ],
  });
  const result = await lookupLatest(ZLIB, providers(fetcher));
  assertEquals(result, { provider: "github", latestVersion: "2.3.4" });
});

Deno.test("github: v-prefixed tags when the URL names the prefix", async () => {
  const fetcher = fake({
    "https://api.github.com/repos/o/r/tags?per_page=100": [
      { name: "v1.2.0" },
      { name: "v1.10.0" },
    ],
  });
  const result = await lookupLatest({
    name: "r",
    currentVersion: "1.2.0",
    url: "https://example.org",
    sourceUrl:
      "https://github.com/o/r/archive/refs/tags/v${recipe.version}.tar.gz",
  }, providers(fetcher));
  assertEquals(result.latestVersion, "1.10.0");
});

Deno.test("github: falls back to releases, then reports a note", async () => {
  const withReleases = fake({
    "https://api.github.com/repos/zlib-ng/zlib-ng/tags?per_page=100": [],
    "https://api.github.com/repos/zlib-ng/zlib-ng/releases?per_page=30": [
      { tag_name: "2.5.0", prerelease: false, draft: false },
      { tag_name: "2.6.0", prerelease: true, draft: false },
    ],
  });
  assertEquals(
    (await lookupLatest(ZLIB, providers(withReleases))).latestVersion,
    "2.5.0",
  );
  const empty = fake({
    "https://api.github.com/repos/zlib-ng/zlib-ng/tags?per_page=100": [],
    "https://api.github.com/repos/zlib-ng/zlib-ng/releases?per_page=30": [],
  });
  const none = await lookupLatest(ZLIB, providers(empty));
  assertEquals(none.latestVersion, undefined);
  assertEquals(none.note?.includes("no stable tag"), true);
});

Deno.test("github: a rate limit surfaces as RateLimited", async () => {
  const fetcher = fake({
    "https://api.github.com/repos/zlib-ng/zlib-ng/tags?per_page=100":
      new Response(
        "{}",
        { status: 403, headers: { "x-ratelimit-remaining": "0" } },
      ),
  });
  await assertRejects(
    () => lookupLatest(ZLIB, providers(fetcher)),
    RateLimited,
    "rate limited",
  );
});

Deno.test("a stalled request fails that lookup after the per-request timeout", async () => {
  const stalled: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal!.reason),
      );
    });
  await assertRejects(
    () => lookupLatest(ZLIB, { ...providers(stalled), requestTimeoutMs: 50 }),
    Error,
    "timed out",
  );
});

Deno.test("anitya: by project id uses stable versions", async () => {
  const fetcher = fake({
    "https://anitya.test/api/v2/projects/7/": {
      id: 7,
      name: "x",
      homepage: "https://x.org",
      versions: ["3.0", "2.0"],
      stable_versions: ["2.1", "2.0"],
    },
  });
  const result = await lookupLatest({
    name: "x",
    currentVersion: "2.0",
    url: "https://x.org",
    sourceUrl: "https://x.org/x-${recipe.version}.tar.gz",
    anityaProjectId: 7,
  }, providers(fetcher));
  assertEquals(result, {
    provider: "anitya",
    projectId: 7,
    latestVersion: "2.1",
  });
});

Deno.test("anitya: search must match the homepage exactly once", async () => {
  const project = (id: number, homepage: string) => ({
    id,
    name: "glib",
    homepage,
    versions: ["2.84.1", "2.85.0-rc1"],
  });
  const input = {
    name: "glib",
    currentVersion: "2.84.0",
    url: "https://wiki.gnome.org/Projects/GLib/",
    sourceUrl: "https://download.gnome.org/glib-${recipe.version}.tar.xz",
  };
  const ok = fake({
    "https://anitya.test/api/v2/projects/?name=glib": {
      items: [
        project(1, "https://crates.io/crates/glib"),
        project(2, "http://wiki.gnome.org/Projects/GLib"),
      ],
    },
  });
  const found = await lookupLatest(input, providers(ok));
  assertEquals(found.projectId, 2);
  assertEquals(found.latestVersion, "2.84.1");
  const collide = fake({
    "https://anitya.test/api/v2/projects/?name=glib": {
      items: [project(1, input.url), project(2, input.url)],
    },
  });
  assertEquals(
    (await lookupLatest(input, providers(collide))).note?.includes(
      "set anityaProjectId",
    ),
    true,
  );
  const missing = fake({
    "https://anitya.test/api/v2/projects/?name=glib": {
      items: [project(1, "https://crates.io/crates/glib")],
    },
  });
  const none = await lookupLatest(input, providers(missing));
  assertEquals(none.latestVersion, undefined);
  assertEquals(none.note?.includes("has homepage"), true);
});

Deno.test("anitya: homepage match ignores scheme, www and trailing slash", async () => {
  const fetcher = fake({
    "https://anitya.test/api/v2/projects/?name=bzip2": {
      items: [
        {
          id: 1,
          name: "bzip2",
          homepage: "https://crates.io/crates/bzip2",
          versions: ["0.5.0"],
        },
        {
          id: 2,
          name: "bzip2",
          homepage: "https://sourceware.org/bzip2/",
          versions: ["1.0.8"],
        },
      ],
    },
  });
  const result = await lookupLatest({
    name: "bzip2",
    currentVersion: "1.0.6",
    url: "https://www.sourceware.org/bzip2",
    sourceUrl:
      "https://sourceware.org/pub/bzip2/bzip2-${recipe.version}.tar.gz",
  }, providers(fetcher));
  assertEquals(result.projectId, 2);
  assertEquals(result.latestVersion, "1.0.8");
});

Deno.test("isNewer and candidateUrl", () => {
  assertEquals(isNewer("2.3.3", "2.3.4"), true);
  assertEquals(isNewer("2.3.3", "2.3.3"), false);
  assertEquals(isNewer("2.3.3", "2.3.2"), false);
  assertEquals(isNewer("2.3.3", undefined), false);
  assertEquals(isNewer("2.3.3", "2.4.0-rc1"), false);
  assertEquals(
    candidateUrl("https://x/${recipe.version}.tgz", "1.2"),
    "https://x/1.2.tgz",
  );
  assertEquals(candidateUrl("https://x/fixed.tgz", "1.2"), undefined);
});
