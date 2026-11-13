import { assertEquals } from "../lib/assert_test.ts";
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
    "@jeremy/mere-dev/recipes",
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
      5,
    );
    const summary = artifacts.find((a) => a.name === "scan")!.attributes;
    assertEquals(summary.total, 5);
    assertEquals(summary.parsed, 5);
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

Deno.test("setVersion edits a worktree recipe and records the change", async () => {
  const repo = await createRepo();
  const tree = await fixtureCheckout();
  try {
    await createRecipe(repo, "merelinux", [
      "--global-arg",
      `checkoutPath=${tree}`,
      "--global-arg",
      "ensureCheckout=false",
    ]);
    const url =
      "https://github.com/zlib-ng/zlib-ng/archive/refs/tags/${recipe.version}.tar.gz";
    const hash = "c".repeat(64);
    const run = await repo.json([
      "behavior",
      "run",
      "merelinux",
      "setVersion",
      "--input",
      "recipe=core/zlib-ng",
      "--input",
      "version=2.3.4",
      "--input",
      `checkoutPath=${tree}`,
      "--input",
      `sources:json=${JSON.stringify([{ url, blake3: hash }])}`,
    ]);
    assertEquals(run.status, "succeeded");
    const change = (run.dataArtifacts as {
      name: string;
      attributes: Record<string, unknown>;
    }[])
      .find((a) => a.name === "change-zlib-ng")!.attributes;
    assertEquals(change.version, { before: "2.3.3", after: "2.3.4" });
    assertEquals(change.release, { before: 7, after: 1 });
    const diff = await new Deno.Command("git", {
      args: ["diff", "--numstat"],
      cwd: tree,
    }).output();
    // version, release and blake3: three lines changed, nothing else.
    assertEquals(
      new TextDecoder().decode(diff.stdout).trim().split("\t").slice(0, 2),
      ["3", "3"],
    );
    // It refuses a missing hash and leaves the file as it is.
    const refused = await repo.json([
      "behavior",
      "run",
      "merelinux",
      "setVersion",
      "--input",
      "recipe=core/zlib-ng",
      "--input",
      "version=2.3.5",
      "--input",
      `checkoutPath=${tree}`,
    ]);
    assertEquals(refused.code, "method_execution_failed");
    assertEquals(String(refused.error).includes("no new BLAKE3"), true);
  } finally {
    await repo.cleanup();
    await Deno.remove(tree, { recursive: true });
  }
});

Deno.test("bumpRelease edits only a worktree recipe and records the change", async () => {
  const repo = await createRepo();
  const tree = await fixtureCheckout();
  try {
    await createRecipe(repo, "merelinux", [
      "--global-arg",
      `checkoutPath=${tree}`,
      "--global-arg",
      "ensureCheckout=false",
    ]);
    const run = await repo.json([
      "behavior",
      "run",
      "merelinux",
      "bumpRelease",
      "--input",
      "recipe=core/zlib-ng",
      "--input",
      `checkoutPath=${tree}`,
    ]);
    assertEquals(run.status, "succeeded");
    const change = (run.dataArtifacts as {
      name: string;
      attributes: Record<string, unknown>;
    }[]).find((a) => a.name === "change-zlib-ng")!.attributes;
    assertEquals(change.version, { before: "2.3.3", after: "2.3.3" });
    assertEquals(change.release, { before: 7, after: 8 });
    assertEquals(change.sources, []);
    const diff = await new Deno.Command("git", {
      args: ["diff", "--numstat"],
      cwd: tree,
    }).output();
    assertEquals(
      new TextDecoder().decode(diff.stdout).trim().split("\t").slice(0, 2),
      ["1", "1"],
    );
  } finally {
    await repo.cleanup();
    await Deno.remove(tree, { recursive: true });
  }
});

Deno.test({
  name:
    "validate and build run mere on a worktree recipe, and failures keep their diagnostics (network)",
  ignore: !NETWORK,
  fn: async () => {
    const repo = await createRepo();
    const tree = await fixtureCheckout();
    try {
      // mere-dev downloads and checksums mere itself; no separate toolchain.
      assertEquals(
        (await repo.swamp([
          "behavior",
          "create",
          "@jeremy/mere-dev",
          "dev",
          "--global-arg",
          "mereVersion=0.23.0",
          "--json",
        ])).code,
        0,
      );
      const args = (recipe: string, path: string) => [
        "--input",
        `recipe=${recipe}`,
        "--input",
        `checkoutPath=${path}`,
      ];

      const valid = await repo.json([
        "behavior",
        "run",
        "dev",
        "validate",
        ...args("core/inih", tree),
      ]);
      assertEquals(valid.status, "succeeded");

      // A recipe mere rejects: validate throws but keeps its record.
      const broken = await Deno.makeTempDir({ prefix: "mere-bad-" });
      await new Deno.Command("cp", { args: ["-r", `${tree}/recipes`, broken] })
        .output();
      const brokenFile = join(broken, "recipes/core/inih/recipe.kdl");
      await Deno.writeTextFile(
        brokenFile,
        (await Deno.readTextFile(brokenFile)).replace(/^\s*version .*$/m, ""),
      );
      const rejected = await repo.json([
        "behavior",
        "run",
        "dev",
        "validate",
        ...args("core/inih", broken),
      ]);
      assertEquals(rejected.code, "method_execution_failed");
      const kept = await repo.json([
        "data",
        "query",
        'modelName == "dev" && name == "validation-result" && isLatest',
        "--select",
        "attributes.ok",
      ]);
      assertEquals(kept.results, [false]);

      // A real build produces a package archive.
      const built = await repo.json([
        "behavior",
        "run",
        "dev",
        "build",
        ...args("core/inih", tree),
      ]);
      assertEquals(built.status, "succeeded");
      const build = (built.dataArtifacts as {
        name: string;
        attributes: Record<string, unknown>;
      }[])
        .find((a) => a.name === "build-result")!.attributes;
      assertEquals(build.ok, true);
      const outputs = build.outputs as {
        package: string;
        sha256: string;
        bytes: number;
      }[];
      assertEquals(outputs.length >= 1, true);
      assertEquals(outputs[0].package.startsWith("inih"), true);
      assertEquals(/^[0-9a-f]{64}$/.test(outputs[0].sha256), true);

      // A build that fails (wrong hash) throws, and says why.
      await Deno.writeTextFile(
        join(broken, "recipes/core/inih/recipe.kdl"),
        (await Deno.readTextFile(join(tree, "recipes/core/inih/recipe.kdl")))
          .replace(/blake3 "[0-9a-f]{64}"/, `blake3 "${"0".repeat(64)}"`),
      );
      const failed = await repo.json([
        "behavior",
        "run",
        "dev",
        "build",
        ...args("core/inih", broken),
      ]);
      assertEquals(failed.code, "method_execution_failed");
      assertEquals(String(failed.error).includes("prepare"), true);
      const record = await repo.json([
        "data",
        "query",
        'modelName == "dev" && name == "build-result" && isLatest',
        "--select",
        "[attributes.ok, attributes.failingPhase, attributes.errorLine]",
      ]);
      const [ok, phase, line] = (record.results as unknown[][])[0];
      assertEquals(ok, false);
      assertEquals(phase, "prepare");
      assertEquals(String(line).includes("blake3 mismatch"), true);
      await Deno.remove(broken, { recursive: true });
    } finally {
      await repo.cleanup();
      await Deno.remove(tree, { recursive: true });
    }
  },
});
