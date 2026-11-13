import { assertEquals, assertRejects } from "./assert_test.ts";
import {
  findHardcodedVersion,
  normalizeContinuations,
  parseRecipe,
  parseUpstreamOverride,
} from "./kdl.ts";

const FIXTURES = new URL("../testdata/merelinux/recipes/", import.meta.url)
  .pathname;

async function load(rel: string) {
  return parseRecipe(
    await Deno.readTextFile(`${FIXTURES}${rel}/recipe.kdl`),
    `recipes/${rel}/recipe.kdl`,
  );
}

Deno.test("parses a typical recipe", async () => {
  const r = await load("core/zlib-ng");
  assertEquals(r.name, "zlib-ng");
  assertEquals(r.category, "core");
  assertEquals(r.version, "2.3.3");
  assertEquals(r.release, 7);
  assertEquals(r.archs, ["aarch64", "x86_64"]);
  assertEquals(r.licenses, ["zlib"]);
  assertEquals(r.depends.includes("musl-dev"), true);
  assertEquals(r.sources.length, 1);
  assertEquals(
    r.sources[0].resolvedUrl,
    "https://github.com/zlib-ng/zlib-ng/archive/refs/tags/2.3.3.tar.gz",
  );
  assertEquals(r.sources[0].interpolatesVersion, true);
  assertEquals(r.sources[0].isLocal, false);
  assertEquals(r.sources[0].blake3?.length, 64);
  assertEquals(r.packages.map((p) => p.name), ["zlib-ng", "zlib-ng-dev"]);
  assertEquals(r.phases, ["build", "install"]);
  assertEquals(r.normalized, false);
});

Deno.test("tolerates a trailing continuation before a closing brace", async () => {
  const r = await load("core/bzip2");
  assertEquals(r.normalized, true);
  assertEquals(r.packages.length >= 3, true);
});

Deno.test("normalizeContinuations only touches a backslash before }", () => {
  const ok = 'files "a" \\\n      "b"\n}';
  assertEquals(normalizeContinuations(ok).normalized, false);
  const bad = 'files "a" \\\n}';
  assertEquals(normalizeContinuations(bad), {
    text: 'files "a" \n}',
    normalized: true,
  });
});

Deno.test("reads services, local sources and needs-root", async () => {
  const busybox = await load("core/busybox");
  assertEquals(busybox.needsRoot, true);
  assertEquals(busybox.sources.some((s) => s.isLocal), true);
  assertEquals(busybox.packages.some((p) => p.hasService), true);
  const mimalloc = await load("core/mimalloc");
  assertEquals(Object.keys(mimalloc.env).length > 0, true);
});

Deno.test("rejects a recipe with no version", async () => {
  await assertRejects(
    () =>
      Promise.resolve().then(() =>
        parseRecipe(
          'recipe {\n name "x"\n release 1\n url "u"\n}',
          "recipes/a/x/recipe.kdl",
        )
      ),
    Error,
    "no version",
  );
});

const REAL_TREE = Deno.env.get("MERE_RECIPES_DIR");

Deno.test({
  name: "every recipe in a real merelinux tree parses (MERE_RECIPES_DIR)",
  ignore: !REAL_TREE,
  fn: async () => {
    let count = 0;
    for await (const category of Deno.readDir(`${REAL_TREE}/recipes`)) {
      if (!category.isDirectory) continue;
      for await (
        const entry of Deno.readDir(`${REAL_TREE}/recipes/${category.name}`)
      ) {
        const file =
          `${REAL_TREE}/recipes/${category.name}/${entry.name}/recipe.kdl`;
        try {
          await Deno.stat(file);
        } catch {
          continue;
        }
        const r = parseRecipe(
          await Deno.readTextFile(file),
          `recipes/${category.name}/${entry.name}/recipe.kdl`,
        );
        assertEquals(
          r.sources.every((s) =>
            s.isLocal || /^[a-f0-9]{64}$/.test(s.blake3 ?? "")
          ),
          true,
          file,
        );
        count++;
      }
    }
    assertEquals(count > 100, true);
  },
});

Deno.test("findHardcodedVersion flags spelled-out versions, not interpolation or longer numbers", () => {
  assertEquals(
    findHardcodedVersion(["ln -s liblua.so.5.4 x", "Version: 5.4.7"], "5.4.7"),
    { exact: true, series: true },
  );
  assertEquals(
    findHardcodedVersion(["make VERSION=${recipe.version}"], "5.4.7"),
    { exact: false, series: false },
  );
  assertEquals(
    findHardcodedVersion(["see 15.4.70 and 5.4.77"], "5.4.7"),
    { exact: false, series: true },
  );
  assertEquals(
    findHardcodedVersion(["python3.14"], "3.14.3"),
    { exact: false, series: true },
  );
  assertEquals(findHardcodedVersion(["62"], "62"), {
    exact: false,
    series: false,
  });
});

Deno.test("parseUpstreamOverride reads corrections and rejects anything else", () => {
  const ok = parseUpstreamOverride(
    `upstream {\n  github "jqlang/jq"\n  tag-prefix "jq-"\n  exclude "^2000"\n  exclude "rc"\n  patch-suffix "p"\n}`,
    "recipes/core/jq/upstream.kdl",
  );
  assertEquals(ok, {
    github: "jqlang/jq",
    tagPrefix: "jq-",
    patchSuffix: "p",
    exclude: ["^2000", "rc"],
  });
  assertEquals(
    parseUpstreamOverride(`upstream {\n  anitya-project-id 13252\n}`, "x"),
    { anityaProjectId: 13252 },
  );
  const bad = [
    `upstream {\n  pin true\n}`,
    `upstream {\n  series "5.4"\n}`,
    `upstream {\n  github "a/b"\n  anitya-project-id 1\n}`,
    `upstream {\n  github "nope"\n}`,
    `upstream {\n  anitya-project-id 0\n}`,
    `upstream {\n  anitya-project-id 1\n  anitya-project-id 2\n}`,
    `upstream {\n  exclude "("\n}`,
    `upstream {\n  patch-suffix "p2"\n}`,
    `other {\n}`,
    ``,
  ];
  for (const text of bad) {
    let threw = false;
    try {
      parseUpstreamOverride(text, "x");
    } catch {
      threw = true;
    }
    assertEquals(threw, true, text);
  }
});

Deno.test("a source built from ${recipe.url} is remote, not local", () => {
  const r = parseRecipe(
    `recipe {
    name "jq"
    version "1.8.1"
    release 1
    url "https://github.com/jqlang/jq"
}
source "\${recipe.url}/releases/download/jq-\${recipe.version}/jq.tar.gz" {
    blake3 "00"
}
package "jq" {
    files "usr/bin/jq"
}
`,
    "recipes/extra/jq/recipe.kdl",
  );
  assertEquals(r.sources[0].isLocal, false);
  assertEquals(
    r.sources[0].resolvedUrl,
    "https://github.com/jqlang/jq/releases/download/jq-1.8.1/jq.tar.gz",
  );
});
