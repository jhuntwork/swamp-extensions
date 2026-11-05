import { assertEquals, assertRejects } from "./assert_test.ts";
import {
  candidateUrl,
  chooseProject,
  githubRepo,
  isNewer,
  lookupLatest,
  pickLatest,
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
  assertEquals(result.provider, "github");
  assertEquals(result.latestVersion, "2.3.4");
  assertEquals(result.latestInSeries, "2.3.4");
  assertEquals(
    result.releaseUrls?.["2.3.4"],
    "https://github.com/zlib-ng/zlib-ng/releases/tag/2.3.4",
  );
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
    "https://anitya.test/api/v2/versions/?project_id=7": {
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
    latestInSeries: "2.0",
    projectUrl: "https://release-monitoring.org/project/7/",
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

Deno.test("pickLatest reports the newest overall and the newest in the current series", () => {
  assertEquals(
    pickLatest(["5.4.7", "5.4.8", "5.5.1", "5.5.0-rc1"], "5.4.7"),
    { latestVersion: "5.5.1", latestInSeries: "5.4.8" },
  );
  assertEquals(
    pickLatest(["6.18.42", "6.18.43", "7.3"], "6.18.42"),
    { latestVersion: "7.3", latestInSeries: "6.18.43" },
  );
  assertEquals(pickLatest(["3.0"], "2.1"), { latestVersion: "3.0" });
  assertEquals(pickLatest([], "1.0"), {});
});

Deno.test("chooseProject prefers the project that already lists the recipe's version", () => {
  const input = {
    name: "openssl",
    currentVersion: "3.6.1",
    url: "https://www.openssl.org",
    sourceUrl: "",
  };
  const items = [
    {
      id: 1,
      name: "openssl",
      homepage: "https://crates.io/crates/openssl",
      versions: ["0.10.1"],
    },
    {
      id: 2,
      name: "openssl",
      homepage: "https://openssl-library.org",
      versions: ["3.6.1", "3.5.0"],
    },
  ];
  assertEquals(chooseProject(items, input), { project: items[1] });
  // Two projects list the version: the homepage breaks the tie, else ask.
  const both = [
    { ...items[0], versions: ["3.6.1"] },
    { ...items[1], homepage: "https://www.openssl.org/" },
  ];
  assertEquals(chooseProject(both, input), { project: both[1] });
  const tied = [items[1], { ...items[1], id: 3 }];
  assertEquals("note" in chooseProject(tied, input), true);
  // Nothing lists it and no homepage matches: say what was tried.
  const none = chooseProject([items[0]], input);
  assertEquals("note" in none && none.note.includes("candidates: 1"), true);
  assertEquals("note" in chooseProject([], input), true);
});

Deno.test("overrides: forced repo and tag prefix, exclusions, forced Anitya project", async () => {
  const gh = fake({
    "https://api.github.com/repos/jqlang/jq/tags?per_page=100": [
      { name: "jq-1.8.1" },
      { name: "jq-1.7.1" },
      { name: "jq-1.9.0-rc1" },
      { name: "20001016" },
    ],
  });
  const jq = await lookupLatest({
    name: "jq",
    currentVersion: "1.8.1",
    url: "https://jqlang.github.io/jq/",
    sourceUrl: "https://example.org/x-${recipe.version}.tar.gz",
    override: { github: "jqlang/jq", tagPrefix: "jq-" },
  }, providers(gh));
  assertEquals(jq.latestVersion, "1.8.1");

  const shadow = fake({
    "https://api.github.com/repos/shadow-maint/shadow/tags?per_page=100": [
      { name: "4.19.4" },
      { name: "20001016" },
    ],
  });
  const input = {
    name: "shadow",
    currentVersion: "4.19.4",
    url: "https://github.com/shadow-maint/shadow",
    sourceUrl:
      "https://github.com/shadow-maint/shadow/releases/download/${recipe.version}/x.tar.xz",
  };
  assertEquals(
    (await lookupLatest(input, providers(shadow))).latestVersion,
    "20001016",
  );
  assertEquals(
    (await lookupLatest(
      { ...input, override: { exclude: ["^2000"] } },
      providers(shadow),
    )).latestVersion,
    "4.19.4",
  );

  const anitya = fake({
    "https://anitya.test/api/v2/versions/?project_id=99": {
      versions: ["2.0"],
      stable_versions: ["2.0"],
    },
  });
  const forced = await lookupLatest({
    name: "x",
    currentVersion: "1.0",
    url: "https://github.com/o/x",
    sourceUrl: "https://github.com/o/x/archive/${recipe.version}.tar.gz",
    override: { anityaProjectId: 99 },
  }, providers(anitya));
  assertEquals(forced.provider, "anitya");
  assertEquals(forced.latestVersion, "2.0");
});

Deno.test("overrides: patch suffix keeps sudo's p2 as current, not older", () => {
  assertEquals(isNewer("1.9.17p2", "1.9.17"), true);
  assertEquals(isNewer("1.9.17p2", "1.9.17", "p"), false);
  assertEquals(isNewer("1.9.17p2", "1.9.17p3", "p"), true);
});
