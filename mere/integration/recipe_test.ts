import { assertEquals } from "../models/_lib/assert_test.ts";
import { createRepo, NETWORK, type Repo } from "./harness.ts";
import { join } from "node:path";

const FIXTURES = new URL("../testdata/merelinux/", import.meta.url).pathname;

async function git(cwd: string, ...args: string[]) {
  const out = await new Deno.Command("git", {
    args: ["-c", "user.name=t", "-c", "user.email=t@example.org", ...args],
    cwd,
  }).output();
  if (out.code !== 0) throw new Error(new TextDecoder().decode(out.stderr));
}

async function fixtureCheckout(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "mere-tree-" });
  await new Deno.Command("cp", { args: ["-r", `${FIXTURES}recipes`, dir] })
    .output();
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "fixtures");
  return dir;
}

async function createRecipe(repo: Repo, name: string, args: string[]) {
  const result = await repo.swamp([
    "behavior",
    "create",
    "@jeremy/mere/recipe",
    name,
    ...args,
    "--json",
  ]);
  assertEquals(result.code, 0, result.stderr);
}

Deno.test("scan parses a tree and reads one recipe on the real engine", async () => {
  const repo = await createRepo();
  const tree = await fixtureCheckout();
  try {
    await createRecipe(repo, "merelinux", [
      "--global-arg",
      `checkoutPath=${tree}`,
      "--global-arg",
      "ensureCheckout=false",
    ]);
    const scan = await repo.json(["behavior", "run", "merelinux", "scan"]);
    assertEquals(scan.status, "succeeded");
    const artifacts = scan.dataArtifacts as {
      name: string;
      attributes: Record<string, unknown>;
    }[];
    assertEquals(
      artifacts.filter((a) => a.name.startsWith("recipe-")).length,
      4,
    );
    const summary = artifacts.find((a) => a.name === "scan")!.attributes;
    assertEquals(summary.total, 4);
    assertEquals(summary.parsed, 4);
    assertEquals(summary.failures, []);
    assertEquals(summary.normalized, ["recipes/core/bzip2/recipe.kdl"]);
    const read = await repo.json([
      "behavior",
      "run",
      "merelinux",
      "read",
      "--input",
      "recipe=core/zlib-ng",
    ]);
    const recipe =
      (read.dataArtifacts as { attributes: Record<string, unknown> }[])[0]
        .attributes;
    assertEquals(recipe.version, "2.3.3");
    assertEquals(recipe.commit, summary.commit);
    const bad = await repo.json([
      "behavior",
      "run",
      "merelinux",
      "read",
      "--input",
      "recipe=../etc",
    ]);
    assertEquals(bad.code !== undefined, true);
  } finally {
    await repo.cleanup();
    await Deno.remove(tree, { recursive: true });
  }
});

Deno.test({
  name: "ensureCheckout clones the real merelinux through @swamp/git (network)",
  ignore: !NETWORK,
  fn: async () => {
    const repo = await createRepo();
    try {
      const pulled = await repo.swamp(["extension", "pull", "@swamp/git"]);
      assertEquals(pulled.code, 0, pulled.stderr);
      await createRecipe(repo, "merelinux", []);
      const scan = await repo.json(["behavior", "run", "merelinux", "scan"]);
      assertEquals(scan.status, "succeeded");
      const summary = (scan.dataArtifacts as {
        name: string;
        attributes: Record<string, unknown>;
      }[]).find((a) => a.name === "scan")!.attributes;
      assertEquals((summary.total as number) > 100, true);
      assertEquals(summary.failures, []);
      await Deno.stat(
        join(repo.dir, ".swamp", "mere", "checkouts", "merelinux", "recipes"),
      );
    } finally {
      await repo.cleanup();
    }
  },
});

Deno.test("upstream.kdl overrides are read, and a bad one is reported without hiding the recipe", async () => {
  const repo = await createRepo();
  const tree = await fixtureCheckout();
  try {
    await Deno.writeTextFile(
      join(tree, "recipes/core/zlib-ng/upstream.kdl"),
      'upstream {\n    github "zlib-ng/zlib-ng"\n    exclude "rc"\n}\n',
    );
    await Deno.writeTextFile(
      join(tree, "recipes/core/bzip2/upstream.kdl"),
      "upstream {\n    pin true\n}\n",
    );
    await git(tree, "add", ".");
    await git(tree, "commit", "-q", "-m", "overrides");
    await createRecipe(repo, "merelinux", [
      "--global-arg",
      `checkoutPath=${tree}`,
      "--global-arg",
      "ensureCheckout=false",
    ]);
    const scan = await repo.json(["behavior", "run", "merelinux", "scan"]);
    const artifacts = scan.dataArtifacts as {
      name: string;
      attributes: Record<string, unknown>;
    }[];
    const summary = artifacts.find((a) => a.name === "scan")!.attributes;
    assertEquals(summary.upstreamOverrides, ["zlib-ng"]);
    const failures = summary.failures as { path: string; error: string }[];
    assertEquals(failures.length, 1);
    assertEquals(failures[0].path, "recipes/core/bzip2/upstream.kdl");
    assertEquals(failures[0].error.includes("pin"), true);
    // The recipe with the bad override is still scanned.
    assertEquals(artifacts.some((a) => a.name === "recipe-core-bzip2"), true);
    const zlib = artifacts.find((a) => a.name === "recipe-core-zlib-ng")!
      .attributes;
    assertEquals(zlib.upstreamOverride, {
      github: "zlib-ng/zlib-ng",
      exclude: ["rc"],
    });
  } finally {
    await repo.cleanup();
    await Deno.remove(tree, { recursive: true });
  }
});
