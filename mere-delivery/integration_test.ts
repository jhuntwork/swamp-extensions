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

/** A bare remote and a worktree with `main` pushed and a bump branch checked out. */
async function fixture(dir: string, message: string, commitIt: boolean) {
  const sh = async (cwd: string, ...args: string[]) => {
    // swamp-quality-ignore deno-command: test fixture repository, fixed argv
    const out = await new Deno.Command("git", {
      args: ["-c", "user.name=t", "-c", "user.email=t@example.org", ...args],
      cwd,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (out.code !== 0) throw new Error(new TextDecoder().decode(out.stderr));
    return new TextDecoder().decode(out.stdout).trim();
  };
  const remote = join(dir, "remote.git");
  const work = join(dir, "work");
  await Deno.mkdir(remote);
  await sh(remote, "init", "-q", "--bare");
  await Deno.mkdir(work);
  await sh(work, "init", "-q", "-b", "main");
  await Deno.writeTextFile(join(work, "recipe.kdl"), "version 1\n");
  await sh(work, "add", ".");
  await sh(work, "commit", "-q", "-m", "base");
  await sh(work, "remote", "add", "origin", remote);
  await sh(work, "push", "-q", "origin", "main");
  const base = await sh(work, "rev-parse", "HEAD");
  await sh(work, "checkout", "-q", "-b", "bump-x-2");
  await Deno.writeTextFile(join(work, "recipe.kdl"), "version 2\n");
  if (commitIt) {
    await sh(work, "add", "recipe.kdl");
    await sh(work, "commit", "-q", "-m", message);
  }
  return { remote, work, base, sh };
}

async function deliver(
  dir: string,
  work: string,
  base: string,
  body: string,
  message: string,
) {
  return await json(dir, [
    "workflow",
    "run",
    "@jeremy/mere-delivery/deliver-change",
    "--input",
    `worktreePath=${work}`,
    "--input",
    "branch=bump-x-2",
    "--input",
    `baseSha=${base}`,
    "--input",
    'allowedPaths:json=["recipe.kdl"]',
    "--input",
    `commitMessage=${message}`,
    "--input",
    `title=${message}`,
    "--input",
    `body=${body}`,
    "--input",
    "profile=merelinux",
    "--input",
    "repository=jhuntwork/merelinux",
    "--input",
    "prBinding=pr",
    "--input",
    "checkName=validation",
    "--input",
    "checkDetail=Covered.",
  ]);
}

async function repoWithExtensions(dir: string) {
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
    "pr",
    "--global-arg",
    "repository=jhuntwork/merelinux",
    "--global-arg",
    "baseBranch=main",
    "--global-arg",
    "expectedActor=nobody",
    "--global-arg",
    "authMode=gh",
  ]);
  assertEquals(created.code, 0, created.stderr);
}

type Step = { name: string; status: string; error?: string };
const stepsOf = (run: { jobs: { steps: Step[] }[] }) =>
  run.jobs.flatMap((j) => j.steps);

Deno.test("a body that breaks the description policy stops the run before anything is committed or pushed", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mere-delivery-it-" });
  try {
    await repoWithExtensions(dir);
    const { remote, work, base, sh } = await fixture(
      dir,
      "x: upgrade to 2",
      false,
    );
    // merelinux allows markdown, so a heading is the violation.
    const run = await deliver(
      dir,
      work,
      base,
      "# Heading\n\ntext",
      "x: upgrade to 2",
    );
    assertEquals(run.status, "failed");
    const steps = stepsOf(run);
    const find = (n: string) => steps.find((s) => s.name === n);
    assertEquals(find("check-description")?.status, "failed");
    assertEquals(
      String(find("check-description")?.error).includes(
        "headings or code fences",
      ),
      true,
    );
    assertEquals(find("commit")?.status, "skipped");
    assertEquals(find("push")?.status, "skipped");
    assertEquals(await sh(remote, "branch", "--list", "bump-x-2"), "");
    assertEquals(await sh(work, "rev-parse", "HEAD"), base);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a branch that already has its commit is not committed twice, and a diff outside the allowed paths is never pushed", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mere-delivery-it-" });
  try {
    await repoWithExtensions(dir);
    const { remote, work, base, sh } = await fixture(
      dir,
      "x: upgrade to 2",
      true,
    );
    const before = await sh(work, "rev-parse", "HEAD");
    // The PR step fails (the fake actor), but only after the commit step was
    // skipped and the branch was pushed exactly as it stood.
    const run = await deliver(dir, work, base, "Fine.", "x: upgrade to 2");
    const steps = stepsOf(run);
    const find = (n: string) => steps.find((s) => s.name === n);
    assertEquals(find("status")?.status, "succeeded");
    assertEquals(find("commit")?.status, "skipped");
    assertEquals(find("head")?.status, "succeeded");
    assertEquals(find("verify-commit")?.status, "succeeded");
    assertEquals(find("assert-scoped")?.status, "succeeded");
    assertEquals(find("push")?.status, "succeeded");
    assertEquals(await sh(work, "rev-parse", "HEAD"), before);
    assertEquals(await sh(remote, "rev-parse", "bump-x-2"), before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a first run commits the allowed paths, then pushes the commit it made", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mere-delivery-it-" });
  try {
    await repoWithExtensions(dir);
    const { remote, work, base, sh } = await fixture(
      dir,
      "x: upgrade to 2",
      false,
    );
    await deliver(dir, work, base, "Fine.", "x: upgrade to 2");
    const head = await sh(work, "rev-parse", "HEAD");
    assertEquals(head === base, false);
    assertEquals(await sh(work, "log", "-1", "--format=%s"), "x: upgrade to 2");
    assertEquals(await sh(remote, "rev-parse", "bump-x-2"), head);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a path outside the allowed list stops the run before the push", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mere-delivery-it-" });
  try {
    await repoWithExtensions(dir);
    const { remote, work, base, sh } = await fixture(
      dir,
      "x: upgrade to 2",
      true,
    );
    await Deno.writeTextFile(join(work, "other.kdl"), "x\n");
    await sh(work, "add", "other.kdl");
    await sh(work, "commit", "-q", "-m", "x: upgrade to 2");
    const run = await deliver(dir, work, base, "Fine.", "x: upgrade to 2");
    const find = (n: string) => stepsOf(run).find((s) => s.name === n);
    assertEquals(find("assert-scoped")?.status, "failed");
    assertEquals(find("push")?.status, "skipped");
    assertEquals(await sh(remote, "branch", "--list", "bump-x-2"), "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a branch with no change at all stops before the push instead of publishing an empty branch", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mere-delivery-it-" });
  try {
    await repoWithExtensions(dir);
    const { remote, work, base, sh } = await fixture(dir, "x", false);
    // Undo the edit the fixture made: a clean tree sitting on the base commit.
    await sh(work, "checkout", "--", "recipe.kdl");
    const run = await deliver(dir, work, base, "Fine.", "x: upgrade to 2");
    const find = (n: string) => stepsOf(run).find((s) => s.name === n);
    assertEquals(run.status, "failed");
    assertEquals(find("status")?.status, "succeeded");
    assertEquals(find("commit")?.status, "skipped");
    // The tip is still the base commit, so the read-back check refuses its
    // subject before the diff is looked at.
    assertEquals(find("verify-commit")?.status, "failed");
    assertEquals(find("push")?.status, "skipped");
    assertEquals(await sh(remote, "branch", "--list", "bump-x-2"), "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
