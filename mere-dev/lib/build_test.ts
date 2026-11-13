import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { join } from "node:path";
import { diagnose, findOutputDir, listOutputs } from "./build.ts";

const HASH = "a".repeat(64);

async function withOutputs(
  dirs: Record<string, string[]>,
  fn: (root: string) => Promise<void>,
) {
  const root = await Deno.makeTempDir({ prefix: "mere-outputs-" });
  try {
    for (const [dir, files] of Object.entries(dirs)) {
      await Deno.mkdir(join(root, dir), { recursive: true });
      for (const file of files) {
        await Deno.writeTextFile(join(root, dir, file), `content of ${file}`);
      }
    }
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("findOutputDir finds the export whatever arch mere used", async () => {
  // mere names the directory with the recipe's arch: a concrete one, `any`,
  // or `unknown` when the recipe declares none (autoconf, automake).
  for (const arch of ["x86_64", "aarch64", "any", "unknown"]) {
    await withOutputs({ [`zlib-ng-2.3.3-7-${arch}`]: [] }, async (root) => {
      const found = await findOutputDir(root, "zlib-ng-2.3.3-7");
      assertEquals(found, join(root, `zlib-ng-2.3.3-7-${arch}`));
    });
  }
});

Deno.test("findOutputDir does not match another release or recipe", async () => {
  await withOutputs({
    "zlib-ng-2.3.3-6-x86_64": [],
    "zlib-ng-dev-2.3.3-7-x86_64": [],
  }, async (root) => {
    assertEquals(await findOutputDir(root, "zlib-ng-2.3.3-7"), undefined);
  });
});

Deno.test("findOutputDir reports a missing root and an ambiguous tuple", async () => {
  assertEquals(await findOutputDir("/nonexistent/outputs", "x-1-1"), undefined);
  await withOutputs({ "x-1-1-x86_64": [], "x-1-1-aarch64": [] }, async (root) => {
    await assertRejects(
      () => findOutputDir(root, "x-1-1"),
      Error,
      "more than one output directory",
    );
  });
});

Deno.test("listOutputs reads package, content id, hash and size from each archive", async () => {
  await withOutputs({
    "linux-firmware-20260519-1-any": [
      `linux-firmware-amd-20260519-1-any-${HASH}.pkg.tar.zst`,
      `linux-firmware-20260519-1-any-${"b".repeat(64)}.pkg.tar.zst`,
      "README.txt",
    ],
  }, async (root) => {
    const outputs = await listOutputs(join(root, "linux-firmware-20260519-1-any"));
    assertEquals(outputs.map((o) => o.package), [
      "linux-firmware",
      "linux-firmware-amd",
    ]);
    assertEquals(outputs[1].contentId, HASH);
    assertEquals(/^[0-9a-f]{64}$/.test(outputs[1].sha256), true);
    assertEquals(outputs[1].bytes > 0, true);
  });
});

Deno.test("diagnose names the failing phase and mere's first error", () => {
  const tail = `prepare inih-62\nerror prepare failed\n  error: blake3 mismatch for x\n`;
  assertEquals(diagnose(tail), {
    failingPhase: "prepare",
    errorLine: "error: blake3 mismatch for x",
  });
  assertEquals(diagnose(""), { failingPhase: "", errorLine: "" });
});
