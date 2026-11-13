import { assertEquals } from "jsr:@std/assert@1.0.19";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;

async function swamp(dir: string, args: string[]) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(Deno.env.toObject())) {
    if (key.startsWith("SWAMP_") && key !== "SWAMP_HOME") continue;
    env[key] = value;
  }
  const out = await new Deno.Command("swamp", {
    args,
    cwd: dir,
    env,
    clearEnv: true,
    stdin: "null",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function json(dir: string, args: string[]) {
  const result = await swamp(dir, [...args, "--json"]);
  for (const text of [result.stdout, result.stderr]) {
    const clean = text.split("\n").filter((l) => !l.startsWith('{"event"'))
      .join("\n").trim();
    if (!clean) continue;
    try {
      return JSON.parse(clean);
    } catch { /* try the next stream */ }
  }
  throw new Error(
    `not JSON (exit ${result.code}): ${result.stdout}${result.stderr}`,
  );
}

Deno.test("deliver-change refuses a message that breaks the profile before it commits anything", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mere-delivery-it-" });
  try {
    assertEquals((await swamp(dir, ["init", "--tool", "none"])).code, 0);
    for (const extension of ["mere-delivery", "github-pr"]) {
      const add = await swamp(dir, [
        "extension",
        "source",
        "add",
        join(ROOT, extension),
      ]);
      assertEquals(add.code, 0, add.stderr);
    }
    const created = await swamp(dir, [
      "behavior",
      "create",
      "@jeremy/github-pr",
      "mere-pr",
      "--global-arg",
      "repository=jhuntwork/mere",
      "--global-arg",
      "baseBranch=main",
      "--global-arg",
      "expectedActor=nobody",
      "--global-arg",
      "authMode=gh",
    ]);
    assertEquals(created.code, 0, created.stderr);

    const cases: Array<[string, string, string]> = [
      ["merelinux", "Upgrade jq to 1.8.2\n\nExplains why.", "bump-jq"],
      [
        "mere",
        "Fix a leak\n\nThe buffer was not freed. All tests pass.",
        "fix-a-leak",
      ],
      ["mere", "Fix a leak\n\nCo-authored-by: A <a@example.org>", "fix-a-leak"],
      ["mere", "Fix a leak", "Bad/Branch"],
    ];
    for (const [profile, message, branch] of cases) {
      const run = await json(dir, [
        "workflow",
        "run",
        "@jeremy/mere-delivery/deliver-change",
        "--input",
        "worktreePath=/nonexistent",
        "--input",
        `branch=${branch}`,
        "--input",
        "baseSha=" + "a".repeat(40),
        "--input",
        'allowedPaths:json=["src/a.zig"]',
        "--input",
        `commitMessage=${message}`,
        "--input",
        `title=${message.split("\n")[0]}`,
        "--input",
        "body=Explains the change.",
        "--input",
        `profile=${profile}`,
        "--input",
        "repository=jhuntwork/mere",
        "--input",
        "prBinding=mere-pr",
        "--input",
        "checkName=validation",
        "--input",
        "checkDetail=Covered.",
      ]);
      assertEquals(run.status, "failed", message);
      const steps = (run.jobs as {
        steps: { name: string; status: string; error?: string }[];
      }[]).flatMap((j) => j.steps);
      const find = (name: string) => steps.find((s) => s.name === name);
      assertEquals(find("check-message")?.status, "failed", message);
      assertEquals(find("commit")?.status, "skipped", message);
      assertEquals(find("push")?.status, "skipped", message);
      assertEquals(
        String(find("check-message")?.error).includes("commit standards"),
        true,
        message,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
