import { assertEquals } from "../models/_lib/assert_test.ts";
import { createRepo } from "./harness.ts";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;

Deno.test("deliver-change refuses a commit that breaks the standards before it commits anything", async () => {
  const repo = await createRepo();
  try {
    for (const pkg of ["github-pr"]) {
      assertEquals(
        (await repo.swamp(["extension", "source", "add", join(ROOT, pkg)]))
          .code,
        0,
      );
    }
    for (
      const [type, name, args] of [
        ["@jeremy/github-pr", "merelinux-pr", [
          "--global-arg",
          "repository=jhuntwork/merelinux",
          "--global-arg",
          "baseBranch=main",
          "--global-arg",
          "expectedActor=nobody",
          "--global-arg",
          "authMode=gh",
        ]],
      ] as [string, string, string[]][]
    ) {
      assertEquals(
        (await repo.swamp([
          "behavior",
          "create",
          type,
          name,
          ...args,
          "--json",
        ])).code,
        0,
        name,
      );
    }
    const bad = [
      "Upgrade jq to 1.8.2",
      "jq: upgrade to 1.8.2\n\nCo-Authored-By: A <a@example.org>",
      "jq: upgrade to 1.8.2\n\nA body.",
    ];
    for (const message of bad) {
      const run = await repo.json([
        "workflow",
        "run",
        "@jeremy/mere/deliver-change",
        "--input",
        "worktreePath=/nonexistent",
        "--input",
        "branch=bump-jq-1.8.2",
        "--input",
        "baseSha=" + "a".repeat(40),
        "--input",
        'allowedPaths:json=["recipes/extra/jq/recipe.kdl"]',
        "--input",
        `commitMessage=${message}`,
        "--input",
        `title=${message.split("\n")[0]}`,
        "--input",
        "body=x",
      ]);
      assertEquals(run.status, "failed", message);
      const steps = (run.jobs as {
        steps: { name: string; status: string; error?: string }[];
      }[]).flatMap((j) => j.steps);
      const status = (n: string) => steps.find((s) => s.name === n)?.status;
      assertEquals(status("check-message"), "failed", message);
      // Nothing after the check ran: no commit, no push.
      assertEquals(status("commit"), "skipped", message);
      assertEquals(status("push"), "skipped", message);
      assertEquals(
        String(steps.find((s) => s.name === "check-message")?.error).includes(
          "commit standards",
        ),
        true,
      );
    }
  } finally {
    await repo.cleanup();
  }
});
