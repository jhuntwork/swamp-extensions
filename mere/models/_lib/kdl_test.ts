import { assertEquals, assertRejects } from "./assert_test.ts";
import { normalizeContinuations, parseRecipe } from "./kdl.ts";

const FIXTURES = new URL("../../testdata/merelinux/recipes/", import.meta.url)
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
