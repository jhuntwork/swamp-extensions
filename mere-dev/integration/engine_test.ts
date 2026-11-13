import { assertEquals } from "../lib/assert_test.ts";
import { createRepo, swampEnv } from "./harness.ts";

Deno.test("harness strips SWAMP_* except SWAMP_HOME", () => {
  const env = swampEnv({
    SWAMP_REPO_DIR: "/x",
    SWAMP_HOME: "/h",
    PATH: "/bin",
  });
  assertEquals(env.SWAMP_REPO_DIR, undefined);
  assertEquals(env.SWAMP_HOME, "/h");
  assertEquals(env.PATH, "/bin");
  // Telemetry is the user's setting; the harness must not touch it.
  assertEquals("SWAMP_NO_TELEMETRY" in env, false);
});

Deno.test("the mere-dev types register on the real engine", async () => {
  const repo = await createRepo();
  try {
    for (const type of ["recipes", "source"]) {
      const found = await repo.json([
        "behavior",
        "type",
        "search",
        `mere-dev/${type}`,
      ]);
      const results = found.results as { normalized: string }[];
      assertEquals(
        results.map((r) => r.normalized),
        [`@jeremy/mere-dev/${type}`],
      );
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
      "@jeremy/mere-dev/source",
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
