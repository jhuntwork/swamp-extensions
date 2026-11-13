import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { join } from "node:path";
import {
  checkoutDir,
  model,
  normalizeType,
  recipeInstanceName,
} from "./recipes.ts";

const ZLIB = await Deno.readTextFile(
  new URL(
    "./testdata/merelinux/recipes/core/zlib-ng/recipe.kdl",
    import.meta.url,
  ),
);

Deno.test("recipe instance names and checkout paths are stable", () => {
  assertEquals(recipeInstanceName("core", "zlib-ng"), "recipe-core-zlib-ng");
  assertEquals(
    checkoutDir("/repo", ""),
    "/repo/.swamp/mere/checkouts/merelinux",
  );
  assertEquals(checkoutDir("/repo", "/elsewhere"), "/elsewhere");
});

Deno.test("the recipes behavior has no mere-running methods or mere globals", () => {
  const methods = Object.keys(model.methods);
  for (const moved of ["validate", "build", "importOutputs"]) {
    assertEquals(methods.includes(moved), false, moved);
  }
  const globals = Object.keys(model.globalArguments.shape);
  assertEquals(globals.includes("toolchain"), false);
  assertEquals(globals.includes("signingKey"), false);
});

Deno.test("the upgrade drops the retired globals and the chain ends at the current version", () => {
  const upgrades = model.upgrades as Array<{
    toVersion: string;
    upgradeAttributes: (o: Record<string, unknown>) => Record<string, unknown>;
  }>;
  assertEquals(upgrades.at(-1)!.toVersion, model.version);
  const retiring = upgrades.find((u) => u.toVersion === "2026.11.13.5")!;
  const migrated = retiring.upgradeAttributes({
    repoUrl: "u",
    ref: "main",
    toolchain: "mere",
    signingKey: "secret",
  });
  assertEquals(migrated, { repoUrl: "u", ref: "main" });
});

async function tree(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "mere-recipes-" });
  await Deno.mkdir(join(dir, "recipes", "core", "zlib-ng"), {
    recursive: true,
  });
  await Deno.writeTextFile(
    join(dir, "recipes", "core", "zlib-ng", "recipe.kdl"),
    ZLIB,
  );
  await Deno.mkdir(join(dir, "recipes", "core", "broken"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "recipes", "core", "broken", "recipe.kdl"),
    'recipe { name "broken" }',
  );
  return dir;
}

function context(root: string) {
  const written: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  return {
    written,
    context: {
      repoDir: root,
      signal: new AbortController().signal,
      definition: { name: "merelinux" },
      globalArgs: model.globalArguments.parse({
        checkoutPath: root,
        ensureCheckout: false,
      }),
      writeResource: (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        written.push({ spec, name, data });
        return Promise.resolve({ name });
      },
      readModelData: () => Promise.resolve([]),
    },
  };
}

async function git(dir: string, ...args: string[]) {
  // swamp-quality-ignore deno-command: test fixture repository, fixed argv
  const out = await new Deno.Command("git", {
    args: ["-c", "user.name=t", "-c", "user.email=t@example.org", ...args],
    cwd: dir,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (out.code !== 0) throw new Error(new TextDecoder().decode(out.stderr));
}

Deno.test("scan parses every recipe and reports one that fails without hiding the rest", async () => {
  const root = await tree();
  try {
    await git(root, "init", "-q", "-b", "main");
    await git(root, "add", ".");
    await git(root, "commit", "-q", "-m", "fixtures");
    const { context: ctx, written } = context(root);
    await model.methods.scan.execute({}, ctx as never);
    const scan = written.find((w) => w.spec === "scan")!.data;
    assertEquals(scan.total, 2);
    assertEquals(scan.parsed, 1);
    assertEquals((scan.failures as { path: string }[]).map((f) => f.path), [
      "recipes/core/broken/recipe.kdl",
    ]);
    assertEquals(
      written.filter((w) => w.spec === "recipe").map((w) => w.name),
      [
        "recipe-core-zlib-ng",
      ],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("workspace computes paths from the key and touches nothing", async () => {
  const root = await Deno.makeTempDir({ prefix: "mere-ws-" });
  try {
    const { context: ctx, written } = context(root);
    await model.methods.workspace.execute(
      { key: "bump-zlib-ng-2.3.4" },
      ctx as never,
    );
    const ws = written[0].data;
    assertEquals(
      ws.worktreePath,
      join(root, ".swamp", "mere", "worktrees", "bump-zlib-ng-2.3.4"),
    );
    assertEquals(ws.key, "bump-zlib-ng-2.3.4");
    await assertRejects(async () => {
      await Deno.stat(join(root, ".swamp"));
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cleanWorktree only accepts bump-* branches and safe keys", () => {
  const schema = model.methods.cleanWorktree.arguments;
  assertEquals(schema.safeParse({ key: "k", branch: "main" }).success, false);
  assertEquals(
    schema.safeParse({ key: "../x", branch: "bump-x" }).success,
    false,
  );
  assertEquals(
    schema.safeParse({ key: "bump-x-1", branch: "bump-x-1" }).success,
    true,
  );
});

// --- checkBindings ----------------------------------------------------------

function bindingContext(
  known: Record<string, string>,
  options: { repository?: boolean } = {},
) {
  const written: Array<{ spec: string; data: Record<string, unknown> }> = [];
  const warnings: string[] = [];
  return {
    written,
    warnings,
    context: {
      writeResource: (
        spec: string,
        _name: string,
        data: Record<string, unknown>,
      ) => {
        written.push({ spec, data });
        return Promise.resolve({ name: spec });
      },
      logger: { warn: (message: string) => warnings.push(message) },
      ...(options.repository === false ? {} : {
        definitionRepository: {
          findByNameGlobal: (name: string) =>
            Promise.resolve(
              name in known
                ? { type: { normalized: normalizeType(known[name]) } }
                : null,
            ),
        },
      }),
    },
  };
}

const wanted = (...pairs: Array<[string, string]>) => ({
  bindings: pairs.map(([name, type]) => ({ name, type })),
});

Deno.test("checkBindings passes when every binding exists with the right type", async () => {
  const { context, written } = bindingContext({
    dev: "@jeremy/mere-dev",
    shell: "@jeremy/mere-shell",
  });
  await model.methods.checkBindings.execute(
    wanted(["dev", "@jeremy/mere-dev"], ["shell", "@jeremy/mere-shell"]),
    context as never,
  );
  assertEquals(written[0].data.ok, true);
  assertEquals(written[0].data.checked, true);
});

Deno.test("checkBindings reports every missing binding at once, with the command to create it", async () => {
  const { context, written } = bindingContext({ dev: "@jeremy/mere-dev" });
  const error = await assertRejects(
    () =>
      model.methods.checkBindings.execute(
        wanted(
          ["dev", "@jeremy/mere-dev"],
          ["shell", "@jeremy/mere-shell"],
          ["pr", "@jeremy/github-pr"],
        ),
        context as never,
      ),
    Error,
  );
  assertEquals(error.message.includes('no binding named "shell"'), true);
  assertEquals(error.message.includes('no binding named "pr"'), true);
  assertEquals(
    error.message.includes("swamp model create @jeremy/mere-shell shell"),
    true,
  );
  assertEquals(error.message.includes('"dev"'), false);
  assertEquals(written[0].data.ok, false);
  assertEquals((written[0].data.bindings as unknown[]).length, 3);
});

Deno.test("checkBindings catches a binding of the wrong type", async () => {
  const { context } = bindingContext({ smoke: "@jeremy/mere-dev" });
  const error = await assertRejects(
    () =>
      model.methods.checkBindings.execute(
        wanted(["smoke", "@jeremy/mere-shell"]),
        context as never,
      ),
    Error,
  );
  assertEquals(
    error.message.includes(
      '"smoke" is a @jeremy/mere-dev, not a @jeremy/mere-shell',
    ),
    true,
  );
});

Deno.test("checkBindings compares types the way swamp normalizes them", () => {
  assertEquals(normalizeType("@Jeremy/Mere-Shell"), "@jeremy/mere-shell");
  assertEquals(normalizeType("@jeremy::mere-dev"), "@jeremy/mere-dev");
});

Deno.test("checkBindings says so, and does not fail, when the engine cannot look bindings up", async () => {
  const { context, written, warnings } = bindingContext({}, {
    repository: false,
  });
  await model.methods.checkBindings.execute(
    wanted(["dev", "@jeremy/mere-dev"]),
    context as never,
  );
  assertEquals(written[0].data.ok, true);
  assertEquals(written[0].data.checked, false);
  assertEquals(warnings.length, 1);
});

// --- packaged workflows -----------------------------------------------------

async function workflow(name: string) {
  return await Deno.readTextFile(new URL(`./${name}`, import.meta.url));
}

Deno.test("recipe-bump and recipe-rebuild check their bindings before touching anything", async () => {
  for (const file of ["recipe-bump.yaml", "recipe-rebuild.yaml"]) {
    const text = await workflow(file);
    const at = (needle: string) => text.indexOf(needle);
    assertEquals(at("name: check-bindings") > 0, true, file);
    assertEquals(at("name: check-bindings") < at("name: scan"), true, file);
    for (
      const type of [
        "@jeremy/mere-dev/recipes",
        '"@jeremy/mere-dev"',
        "@jeremy/github-pr",
      ]
    ) {
      assertEquals(text.includes(type), true, `${file} ${type}`);
    }
  }
  const bump = await workflow("recipe-bump.yaml");
  assertEquals(bump.includes('type: "@jeremy/mere-shell"'), true);
  assertEquals(bump.includes('type: "@jeremy/mere-dev/source"'), true);
});

Deno.test("recipe-bump refuses a smoke test that cannot fail or does not cover the recipe", async () => {
  const text = await workflow("recipe-bump.yaml");
  const at = (needle: string) => text.indexOf(needle);
  assertEquals(at("name: assert-meaningful-smoke") < at("name: scan"), true);
  assertEquals(at("name: assert-smoke-covers-recipe") < at("name: plan"), true);
  assertEquals(text.includes('["true", ":", "echo", "test", "["]'), true);
});

Deno.test("recipe-rebuild names its branch after the new release, so a later rebuild never reuses it", async () => {
  const text = await workflow("recipe-rebuild.yaml");
  assertEquals(text.includes('"-rebuild"'), false);
  assertEquals(text.includes('"-release-"'), true);
  assertEquals(text.includes(".attributes.release) + 1"), true);
});

function notesContext(
  data: Record<string, Array<Record<string, unknown>>>,
  repoDir = "/repo",
) {
  const written: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  return {
    written,
    context: {
      repoDir,
      signal: new AbortController().signal,
      definition: { name: "merelinux" },
      globalArgs: model.globalArguments.parse({ ensureCheckout: false }),
      writeResource: (
        spec: string,
        name: string,
        payload: Record<string, unknown>,
      ) => {
        written.push({ spec, name, data: payload });
        return Promise.resolve({ name });
      },
      readModelData: (_binding: string, spec?: string) =>
        Promise.resolve(
          (data[spec ?? ""] ?? []).map((attributes) => ({
            name: attributes.name as string,
            attributes,
          })),
        ),
    },
  };
}

const HASH = "a".repeat(64);
const CHANGELOG = `libpng changes

Version 1.6.59 [September 28, 2026]
  Fixed CVE-2026-46675 (medium severity):
    Use-after-free of zlib input in png_read_end after incomplete zTXt, iTXt
    or iCCP decompression.
  Prevented a double free of png_struct members after an allocation failure.
`;

/** A repo directory holding a real tar archive keyed by the recorded hash. */
async function repoWithArchive(): Promise<string> {
  const repo = await Deno.makeTempDir({ prefix: "mere-notes-" });
  const staging = join(repo, "stage", "libpng-1.6.59");
  await Deno.mkdir(staging, { recursive: true });
  await Deno.writeTextFile(join(staging, "CHANGES"), CHANGELOG);
  const downloads = join(repo, ".swamp", "mere", "downloads");
  await Deno.mkdir(downloads, { recursive: true });
  // swamp-quality-ignore deno-command: test fixture archive, fixed argv
  const made = await new Deno.Command("tar", {
    args: [
      "-cf",
      join(downloads, HASH),
      "-C",
      join(repo, "stage"),
      "libpng-1.6.59",
    ],
  }).output();
  if (made.code !== 0) throw new Error("tar failed");
  return repo;
}

const CHANGE = [{
  name: "change-libpng",
  version: { before: "1.6.56", after: "1.6.59" },
  sources: [{
    url: "https://x/libpng-${recipe.version}.tar",
    blake3After: HASH,
  }],
}];

const ENTRIES = {
  recipe: "desktop/libpng",
  version: "1.6.59",
  file: "libpng-1.6.59/CHANGES",
  entries: [
    {
      version: "1.6.59",
      quote:
        "Fixed CVE-2026-46675 (medium severity): Use-after-free of zlib input in png_read_end after incomplete zTXt, iTXt or iCCP decompression.",
    },
    {
      version: "1.6.59",
      quote:
        "Prevented a double free of png_struct members after an allocation failure.",
    },
  ],
};

Deno.test("recordReviewNotes stores quoted entries as markdown, grouped by release", async () => {
  const repo = await repoWithArchive();
  try {
    const { context: ctx, written } = notesContext({ change: CHANGE }, repo);
    await model.methods.recordReviewNotes.execute(ENTRIES, ctx as never);
    assertEquals(written.length, 1);
    assertEquals(written[0].spec, "review-notes");
    assertEquals(
      written[0].data.notes,
      `1.6.59:\n\n- ${ENTRIES.entries[0].quote}\n- ${ENTRIES.entries[1].quote}`,
    );
    assertEquals(
      written[0].data.source,
      "libpng-1.6.59/CHANGES in https://x/libpng-1.6.59.tar",
    );
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("recordReviewNotes refuses an entry that is not in the changelog", async () => {
  const repo = await repoWithArchive();
  try {
    const { context: ctx, written } = notesContext({ change: CHANGE }, repo);
    await assertRejects(
      () =>
        model.methods.recordReviewNotes.execute({
          ...ENTRIES,
          entries: [{
            version: "1.6.59",
            quote: "Fixed a serious use-after-free that could leak memory.",
          }],
        }, ctx as never),
      Error,
      "is not in the changelog",
    );
    assertEquals(written.length, 0);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("recordReviewNotes names a file that is not in the archive", async () => {
  const repo = await repoWithArchive();
  try {
    const { context: ctx } = notesContext({ change: CHANGE }, repo);
    await assertRejects(
      () =>
        model.methods.recordReviewNotes.execute(
          { ...ENTRIES, file: "libpng-1.6.59/NOPE" },
          ctx as never,
        ),
      Error,
      "was not found in the source archive",
    );
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("recordReviewNotes refuses a version that differs from the change", async () => {
  const { context: ctx, written } = notesContext({
    change: [{ ...CHANGE[0], version: { before: "1.6.56", after: "1.6.58" } }],
  });
  await assertRejects(
    () => model.methods.recordReviewNotes.execute(ENTRIES, ctx as never),
    Error,
    "1.6.58, not 1.6.59",
  );
  assertEquals(written.length, 0);
});

Deno.test("recordReviewNotes refuses when no change was recorded", async () => {
  const { context: ctx } = notesContext({});
  await assertRejects(
    () => model.methods.recordReviewNotes.execute(ENTRIES, ctx as never),
    Error,
    "missing, not 1.6.59",
  );
});

Deno.test("recordReviewNotes arguments refuse a path outside the archive and an empty list", () => {
  const args = model.methods.recordReviewNotes.arguments;
  for (const file of ["/etc/passwd", "../x/NEWS", "a/../../b"]) {
    assertEquals(args.safeParse({ ...ENTRIES, file }).success, false, file);
  }
  assertEquals(args.safeParse({ ...ENTRIES, entries: [] }).success, false);
  assertEquals(args.safeParse(ENTRIES).success, true);
});

Deno.test("summarize puts the recorded notes in the PR body and ignores notes for another version", async () => {
  const base = {
    change: [{
      name: "change-libpng",
      version: { before: "1.6.56", after: "1.6.59" },
      release: { before: 2, after: 1 },
      sources: [],
    }],
    recipe: [{ name: "libpng", depends: [] }],
  };
  const upstream = {
    bump: [{
      name: "bump-libpng",
      bumpKind: "patch",
      targetSource: "latestInSeries",
      needsMigration: false,
      hardcodedVersion: { exact: false, series: false },
      releaseNotesUrl: "https://example.test/notes",
    }],
    "build-result": [{
      name: "build-result",
      recipe: "desktop/libpng",
      ok: true,
      arch: "x86_64",
      durationMs: 1,
      noCache: true,
      outputs: [],
    }],
  };
  const run = async (
    reviewNotes: Array<Record<string, unknown>>,
    requireReviewNotes = false,
  ) => {
    const { context: ctx, written } = notesContext({
      ...base,
      ...upstream,
      "review-notes": reviewNotes,
    });
    await model.methods.summarize.execute({
      recipe: "desktop/libpng",
      sourceBinding: "s",
      devBinding: "d",
      runId: "r",
      requireReviewNotes,
    }, ctx as never);
    return written.find((w) => w.spec === "summary")!.data.body as string;
  };
  const notes = "1.6.59:\n\n- Prevented a double free.";
  assertEquals(
    await run([{ name: "libpng", version: "1.6.59", notes }]),
    `${notes}\n\nRelease notes: https://example.test/notes`,
  );
  assertEquals(
    await run([{ name: "libpng", version: "1.6.58", notes: "- Stale." }]),
    "Release notes: https://example.test/notes",
  );
  // A required review that was approved without recording anything must not
  // fall through to a link-only body.
  await assertRejects(
    () => run([], true),
    Error,
    "no review notes were recorded for libpng 1.6.59",
  );
  await assertRejects(
    () => run([{ name: "libpng", version: "1.6.58", notes: "- Stale." }], true),
    Error,
    "no review notes were recorded",
  );
  assertEquals(
    await run([{ name: "libpng", version: "1.6.59", notes }], true),
    `${notes}\n\nRelease notes: https://example.test/notes`,
  );
});
