import { assertEquals } from "../models/_lib/assert_test.ts";
import { sha256File } from "../toolchain.ts";
import { createRepo } from "./harness.ts";

const MERE_BIN = Deno.env.get("MERE_BIN") ?? "";
const MERE_ROOT = Deno.env.get("MERE_ROOT") ?? "";
const ENABLED = Deno.env.get("MERE_PROFILE_INTEGRATION") === "1";

Deno.test({
  name: "profile runs exact argv in an isolated Mere package set",
  ignore: !ENABLED || !MERE_BIN || !MERE_ROOT,
  fn: async () => {
    const repo = await createRepo();
    try {
      const sha256 = await sha256File(MERE_BIN);
      assertEquals(
        (await repo.swamp([
          "behavior",
          "create",
          "@jeremy/mere/toolchain",
          "mere",
          "--global-arg",
          "mereVersion=0.23.0",
          "--global-arg",
          `mereRoot=${MERE_ROOT}`,
          "--json",
        ])).code,
        0,
      );
      assertEquals(
        (await repo.json([
          "behavior",
          "run",
          "mere",
          "provision",
          "--input",
          `archivePath=${MERE_BIN}`,
          "--input",
          `sha256=${sha256}`,
        ])).status,
        "succeeded",
      );
      assertEquals(
        (await repo.swamp([
          "behavior",
          "create",
          "@jeremy/mere/profile",
          "smoke",
          "--global-arg",
          "toolchain=mere",
          "--json",
        ])).code,
        0,
      );
      const run = await repo.json([
        "behavior",
        "run",
        "smoke",
        "run",
        "--input",
        'packages:json=["busybox"]',
        "--input",
        'argv:json=["busybox","echo","profile-ok"]',
        "--input",
        "workdir=/",
      ]);
      assertEquals(run.status, "succeeded");
      const result = (run.dataArtifacts as {
        name: string;
        attributes: Record<string, unknown>;
      }[]).find((artifact) => artifact.name === "current")!.attributes;
      assertEquals(result.success, true);
      assertEquals(result.exitCode, 0);
      assertEquals(result.stdout, "profile-ok\n");
      assertEquals(result.packages, ["busybox"]);
      assertEquals(result.argv, ["busybox", "echo", "profile-ok"]);
    } finally {
      await repo.cleanup();
    }
  },
});
