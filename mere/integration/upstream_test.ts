import { assertEquals } from "../models/_lib/assert_test.ts";
import { createRepo, NETWORK } from "./harness.ts";

const FIXTURES = new URL("../testdata/merelinux/", import.meta.url).pathname;

async function fixtureTree(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "mere-tree-" });
  await new Deno.Command("cp", { args: ["-r", `${FIXTURES}recipes`, dir] })
    .output();
  for (
    const args of [
      ["init", "-q", "-b", "main"],
      ["add", "."],
      ["commit", "-q", "-m", "fixtures"],
    ]
  ) {
    const out = await new Deno.Command("git", {
      args: ["-c", "user.name=t", "-c", "user.email=t@example.org", ...args],
      cwd: dir,
    }).output();
    if (out.code !== 0) throw new Error(new TextDecoder().decode(out.stderr));
  }
  return dir;
}

Deno.test("scanLatest refuses to run before a recipe scan", async () => {
  const repo = await createRepo();
  try {
    assertEquals(
      (await repo.swamp([
        "behavior",
        "create",
        "@jeremy/mere/source",
        "up",
        "--json",
      ])).code,
      0,
    );
    const result = await repo.json([
      "behavior",
      "run",
      "up",
      "scanLatest",
      "--input",
      "recipeBinding=nothing",
    ]);
    assertEquals(result.code, "method_execution_failed");
    assertEquals(String(result.error).includes("run its scan first"), true);
  } finally {
    await repo.cleanup();
  }
});

Deno.test({
  name:
    "scan then scanLatest finds upstream versions for real recipes (network)",
  ignore: !NETWORK,
  fn: async () => {
    const repo = await createRepo();
    const tree = await fixtureTree();
    try {
      for (
        const [type, name, args] of [
          ["recipe", "merelinux", [
            "--global-arg",
            `checkoutPath=${tree}`,
            "--global-arg",
            "ensureCheckout=false",
          ]],
          ["source", "up", []],
        ] as [string, string, string[]][]
      ) {
        const created = await repo.swamp([
          "behavior",
          "create",
          `@jeremy/mere/${type}`,
          name,
          ...args,
          "--json",
        ]);
        assertEquals(created.code, 0, created.stderr);
      }
      assertEquals(
        (await repo.json(["behavior", "run", "merelinux", "scan"])).status,
        "succeeded",
      );
      const latest = await repo.json(["behavior", "run", "up", "scanLatest"]);
      assertEquals(latest.status, "succeeded");
      const records = latest.dataArtifacts as {
        name: string;
        attributes: Record<string, unknown>;
      }[];
      assertEquals(records.length, 5);
      const zlib = records.find((r) => r.name === "upstream-zlib-ng")!
        .attributes;
      assertEquals(zlib.provider, "github");
      assertEquals(typeof zlib.latestVersion, "string");
      assertEquals(zlib.currentVersion, "2.3.3");
      console.log(
        records.map((r) =>
          `${r.attributes.name}: ${r.attributes.currentVersion} -> ${
            r.attributes.latestVersion ?? "?"
          } via ${r.attributes.provider}${
            r.attributes.note ? " (" + r.attributes.note + ")" : ""
          }`
        ).join("\n"),
      );
    } finally {
      await repo.cleanup();
      await Deno.remove(tree, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "the bundled recipe-scan workflow runs and its drift report renders (network)",
  ignore: !NETWORK,
  fn: async () => {
    const repo = await createRepo();
    const tree = await fixtureTree();
    try {
      for (
        const [type, name, args] of [
          ["recipe", "merelinux", [
            "--global-arg",
            `checkoutPath=${tree}`,
            "--global-arg",
            "ensureCheckout=false",
          ]],
          ["source", "merelinux-upstream", []],
        ] as [string, string, string[]][]
      ) {
        const created = await repo.swamp([
          "behavior",
          "create",
          `@jeremy/mere/${type}`,
          name,
          ...args,
          "--json",
        ]);
        assertEquals(created.code, 0, created.stderr);
      }
      const validated = await repo.json([
        "workflow",
        "validate",
        "recipe-scan",
      ]);
      assertEquals(validated.passed, true);
      const run = await repo.json(["workflow", "run", "recipe-scan"]);
      assertEquals(run.status, "succeeded");
      const report = await repo.swamp([
        "report",
        "get",
        "@jeremy/mere/upstream-drift",
        "--workflow",
        "recipe-scan",
        "--markdown",
      ]);
      assertEquals(report.code, 0, report.stderr);
      assertEquals(report.stdout.includes("5 recipes checked"), true);
      assertEquals(report.stdout.includes("| mimalloc |"), true);
      assertEquals(report.stdout.includes("bzip2/recipe.kdl"), true);
    } finally {
      await repo.cleanup();
      await Deno.remove(tree, { recursive: true });
    }
  },
});
