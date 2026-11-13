import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { join } from "node:path";
import { checkoutDir, model, recipeInstanceName } from "./recipes.ts";

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
  const migrated = upgrades.at(-1)!.upgradeAttributes({
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
