import { assertEquals, assertRejects } from "./assert_test.ts";
import { bumpRelease, setVersion } from "./edit.ts";
import { parseRecipe } from "./kdl.ts";

const FIXTURES = new URL("../testdata/merelinux/recipes/", import.meta.url)
  .pathname;
const load = (rel: string) => Deno.readTextFile(`${FIXTURES}${rel}/recipe.kdl`);
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const ZLIB_URL =
  "https://github.com/zlib-ng/zlib-ng/archive/refs/tags/${recipe.version}.tar.gz";

function rejects(fn: () => unknown, message: string) {
  return assertRejects(() => Promise.resolve().then(fn), Error, message);
}

Deno.test("bumpRelease changes only the release", async () => {
  const text = await load("core/zlib-ng");
  const { text: edited, change } = bumpRelease(
    text,
    "recipes/core/zlib-ng/recipe.kdl",
  );
  const before = text.split("\n");
  const after = edited.split("\n");
  const differing = before.flatMap((line, index) =>
    line === after[index] ? [] : [index]
  );
  assertEquals(differing.length, 1);
  assertEquals(edited.includes('version "2.3.3"'), true);
  assertEquals(edited.includes("release 8"), true);
  assertEquals(change.version, { before: "2.3.3", after: "2.3.3" });
  assertEquals(change.release, { before: 7, after: 8 });
  assertEquals(change.sources, []);
  assertEquals(
    parseRecipe(edited, "recipes/core/zlib-ng/recipe.kdl").release,
    8,
  );
});
Deno.test("setVersion changes only version, release and the source hash", async () => {
  const text = await load("core/zlib-ng");
  const { text: edited, change } = setVersion(
    text,
    "recipes/core/zlib-ng/recipe.kdl",
    { version: "2.3.4", hashes: { [ZLIB_URL]: H1 } },
  );
  const before = text.split("\n");
  const after = edited.split("\n");
  assertEquals(after.length, before.length);
  const differing = before.flatMap((l, i) => l === after[i] ? [] : [i]);
  assertEquals(differing.length, 3);
  assertEquals(edited.includes('version "2.3.4"'), true);
  assertEquals(edited.includes("release 1"), true);
  assertEquals(edited.includes(`blake3 "${H1}"`), true);
  assertEquals(change.version, { before: "2.3.3", after: "2.3.4" });
  assertEquals(change.release, { before: 7, after: 1 });
  assertEquals(change.sources[0].blake3After, H1);
  assertEquals(change.fileSha256Before === change.fileSha256After, false);
  assertEquals(
    parseRecipe(edited, "recipes/core/zlib-ng/recipe.kdl").version,
    "2.3.4",
  );
});

Deno.test("setVersion then setting it back is byte-identical", async () => {
  for (const name of ["zlib-ng", "bzip2", "busybox", "mimalloc"]) {
    const rel = `recipes/core/${name}/recipe.kdl`;
    const text = await load(`core/${name}`);
    const original = parseRecipe(text, rel);
    const hashes = Object.fromEntries(
      original.sources.filter((s) => !s.isLocal && s.interpolatesVersion)
        .map((s) => [s.url, H1]),
    );
    const edited = setVersion(text, rel, {
      version: "99.0.1",
      release: 5,
      hashes,
      allowHardcodedVersion: true,
    });
    const back = setVersion(edited.text, rel, {
      version: original.version,
      release: original.release,
      hashes: Object.fromEntries(
        original.sources.filter((s) => !s.isLocal && s.interpolatesVersion)
          .map((s) => [s.url, s.blake3!]),
      ),
      allowHardcodedVersion: true,
    });
    assertEquals(back.text, text, name);
  }
});

Deno.test("setVersion refuses bad input", async () => {
  const text = await load("core/zlib-ng");
  const rel = "recipes/core/zlib-ng/recipe.kdl";
  await rejects(
    () =>
      setVersion(text, rel, { version: "2.3.3", hashes: { [ZLIB_URL]: H1 } }),
    "already at",
  );
  await rejects(
    () => setVersion(text, rel, { version: "2.3.4", hashes: {} }),
    "no new BLAKE3",
  );
  await rejects(
    () =>
      setVersion(text, rel, {
        version: "2.3.4",
        hashes: { [ZLIB_URL]: "xyz" },
      }),
    "invalid BLAKE3",
  );
  await rejects(
    () =>
      setVersion(text, rel, {
        version: "2.3.4",
        hashes: { [ZLIB_URL]: H1, "https://x/y": H2 },
      }),
    "no source",
  );
  await rejects(
    () =>
      setVersion(text, rel, { version: '2"; rm', hashes: { [ZLIB_URL]: H1 } }),
    "invalid version",
  );
  await rejects(
    () =>
      setVersion(text, rel, {
        version: "2.3.4",
        release: -1,
        hashes: { [ZLIB_URL]: H1 },
      }),
    "release",
  );
});

Deno.test("setVersion refuses a recipe that hardcodes its version unless told to", async () => {
  const text = `recipe {
    name "lua"
    version "5.4.7"
    release 1
    url "https://www.lua.org"
}

source "https://www.lua.org/ftp/lua-\${recipe.version}.tar.gz" {
    blake3 "${H2}"
}

install {
    script r#"
        ln -s liblua.so.5.4 x
    "#
}

package "lua" {
    files "usr/bin/lua"
}
`;
  const rel = "recipes/extra/lua/recipe.kdl";
  const url = "https://www.lua.org/ftp/lua-${recipe.version}.tar.gz";
  await rejects(
    () => setVersion(text, rel, { version: "5.5.1", hashes: { [url]: H1 } }),
    "spells out its version",
  );
  const ok = setVersion(text, rel, {
    version: "5.5.1",
    hashes: { [url]: H1 },
    allowHardcodedVersion: true,
  });
  assertEquals(ok.change.hardcodedVersion.series, true);
});

Deno.test("setVersion leaves local and non-versioned sources alone", async () => {
  const text = await load("core/busybox");
  const rel = "recipes/core/busybox/recipe.kdl";
  const original = parseRecipe(text, rel);
  const versioned = original.sources.filter((s) =>
    !s.isLocal && s.interpolatesVersion
  );
  const edited = setVersion(text, rel, {
    version: "1.99.0",
    hashes: Object.fromEntries(versioned.map((s) => [s.url, H1])),
    allowHardcodedVersion: true,
  });
  const after = parseRecipe(edited.text, rel);
  assertEquals(
    after.sources.filter((s) => s.isLocal).map((s) => s.blake3),
    original.sources.filter((s) => s.isLocal).map((s) => s.blake3),
  );
});

const REAL_TREE = Deno.env.get("MERE_RECIPES_DIR");

Deno.test({
  name:
    "every recipe in a real tree round-trips through setVersion (MERE_RECIPES_DIR)",
  ignore: !REAL_TREE,
  fn: async () => {
    let count = 0;
    const problems: string[] = [];
    for await (const category of Deno.readDir(`${REAL_TREE}/recipes`)) {
      if (!category.isDirectory) continue;
      for await (
        const entry of Deno.readDir(`${REAL_TREE}/recipes/${category.name}`)
      ) {
        const rel = `recipes/${category.name}/${entry.name}/recipe.kdl`;
        let text: string;
        try {
          text = await Deno.readTextFile(`${REAL_TREE}/${rel}`);
        } catch {
          continue;
        }
        const original = parseRecipe(text, rel);
        const versioned = original.sources.filter((s) =>
          !s.isLocal && s.interpolatesVersion
        );
        try {
          const forward = setVersion(text, rel, {
            version: "9999.1",
            release: 3,
            hashes: Object.fromEntries(versioned.map((s) => [s.url, H1])),
            allowHardcodedVersion: true,
          });
          const back = setVersion(forward.text, rel, {
            version: original.version,
            release: original.release,
            hashes: Object.fromEntries(
              versioned.map((s) => [s.url, s.blake3!]),
            ),
            allowHardcodedVersion: true,
          });
          if (back.text !== text) problems.push(`${rel}: not byte-identical`);
          count++;
        } catch (error) {
          problems.push(
            `${rel}: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    }
    assertEquals(problems, []);
    assertEquals(count > 100, true);
  },
});
