import { assertEquals } from "../models/_lib/assert_test.ts";
import { createRepo, NETWORK, repoPath, swampEnv } from "./harness.ts";

Deno.test("harness strips SWAMP_* except SWAMP_HOME", () => {
  const env = swampEnv({
    SWAMP_REPO_DIR: "/x",
    SWAMP_HOME: "/h",
    PATH: "/bin",
  });
  assertEquals(env.SWAMP_REPO_DIR, undefined);
  assertEquals(env.SWAMP_HOME, "/h");
  assertEquals(env.PATH, "/bin");
  assertEquals(env.SWAMP_NO_TELEMETRY, "1");
});

Deno.test("both mere types register on the real engine", async () => {
  const repo = await createRepo();
  try {
    for (const type of ["source", "toolchain"]) {
      const found = await repo.json([
        "behavior",
        "type",
        "search",
        `mere/${type}`,
      ]);
      const results = found.results as { normalized: string }[];
      assertEquals(results.map((r) => r.normalized), [`@jeremy/mere/${type}`]);
    }
  } finally {
    await repo.cleanup();
  }
});

Deno.test("fetchHash refuses a non-HTTPS URL through the engine", async () => {
  const repo = await createRepo();
  try {
    const result = await repo.json([
      "behavior",
      "run",
      "@jeremy/mere/source",
      "fetchHash",
      "probe",
      "--input",
      "url=http://example.org/x",
    ]);
    assertEquals(result.code, "method_execution_failed");
    assertEquals(String(result.error).includes("HTTPS"), true);
  } finally {
    await repo.cleanup();
  }
});

Deno.test("toolchain pin rejects 'latest' and status fails without a binary", async () => {
  const repo = await createRepo();
  try {
    const bad = await repo.swamp([
      "behavior",
      "create",
      "@jeremy/mere/toolchain",
      "bad",
      "--global-arg",
      "mereVersion=latest",
      "--json",
    ]);
    const badOk = bad.code === 0 &&
      (await repo.swamp(["behavior", "validate", "bad", "--json"])).code === 0;
    assertEquals(badOk, false);
    const created = await repo.swamp([
      "behavior",
      "create",
      "@jeremy/mere/toolchain",
      "mere-0230",
      "--global-arg",
      "mereVersion=0.23.0",
      "--json",
    ]);
    assertEquals(created.code, 0);
    const status = await repo.json([
      "behavior",
      "run",
      "mere-0230",
      "status",
      "--input",
      `sha256=${"0".repeat(64)}`,
    ]);
    assertEquals(status.code, "method_execution_failed");
    assertEquals(
      await Deno.stat(repoPath(repo, ".swamp", "mere", "mere-0230", "root"))
        .then(
          () => true,
          () => false,
        ),
      false,
    );
  } finally {
    await repo.cleanup();
  }
});

Deno.test({
  name: "provision installs the real mere 0.23.0 end to end (network)",
  ignore: !NETWORK,
  fn: async () => {
    const repo = await createRepo();
    try {
      const pulled = await repo.swamp([
        "extension",
        "pull",
        "@svendowideit/github-release-install",
      ]);
      assertEquals(pulled.code, 0);
      const create = await repo.swamp([
        "behavior",
        "create",
        "@svendowideit/github-release-install",
        "mere-release",
        "--global-arg",
        "repo=jhuntwork/mere",
        "--global-arg",
        "format=raw",
        "--global-arg",
        "checksumsName=SHA256SUMS",
        "--global-arg",
        "assetPattern=^(?<stem>mere)-(?<version>[^-]+)-(?<os>linux)-(?<arch>[^.]+)$",
        "--json",
      ]);
      assertEquals(create.code, 0);
      const archive = repoPath(repo, ".swamp", "mere", "download", "mere");
      const download = await repo.json([
        "behavior",
        "run",
        "mere-release",
        "download",
        "--input",
        "version=0.23.0",
        "--input",
        `outputPath=${archive}`,
      ]);
      assertEquals(download.status, "succeeded");
      const attrs =
        (download.dataArtifacts as { attributes: { sha256: string } }[])[0]
          .attributes;
      const toolchain = await repo.swamp([
        "behavior",
        "create",
        "@jeremy/mere/toolchain",
        "mere-0230",
        "--global-arg",
        "mereVersion=0.23.0",
        "--json",
      ]);
      assertEquals(toolchain.code, 0);
      const args = [
        "behavior",
        "run",
        "mere-0230",
        "provision",
        "--input",
        `archivePath=${archive}`,
        "--input",
        `sha256=${attrs.sha256}`,
      ];
      const first = await repo.json(args);
      assertEquals(first.status, "succeeded");
      const data =
        (first.dataArtifacts as { attributes: Record<string, unknown> }[])[0]
          .attributes;
      assertEquals(data.version, "0.23.0");
      assertEquals(data.sha256, attrs.sha256);
      assertEquals(
        data.storePresent && data.configPresent && data.keyPresent,
        true,
      );
      const second = await repo.json(args);
      assertEquals(second.status, "succeeded");
    } finally {
      await repo.cleanup();
    }
  },
});
