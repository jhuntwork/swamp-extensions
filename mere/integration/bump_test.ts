import { assertEquals } from "../models/_lib/assert_test.ts";
import { createRepo, NETWORK } from "./harness.ts";
import { join } from "node:path";

const FIXTURES = new URL("../testdata/merelinux/", import.meta.url).pathname;
const ROOT = new URL("../../", import.meta.url).pathname;

async function git(cwd: string, ...args: string[]) {
  const out = await new Deno.Command("git", {
    args: ["-c", "user.name=t", "-c", "user.email=t@example.org", ...args],
    cwd,
  }).output();
  if (out.code !== 0) throw new Error(new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout);
}

/**
 * recipe-bump end to end on a LOCAL remote, so nothing can reach the real
 * merelinux. The run is expected to stop at deliver-change's plan-pr (the
 * remote is not on GitHub); everything before it is checked, including the
 * pushed branch.
 */
Deno.test({
  name:
    "recipe-bump prepares, builds and pushes a bump branch to a local remote (network)",
  ignore: !NETWORK,
  fn: async () => {
    const repo = await createRepo();
    const scratch = await Deno.makeTempDir({ prefix: "mere-bump-" });
    try {
      const remote = join(scratch, "remote.git");
      const seed = join(scratch, "seed");
      await Deno.mkdir(seed);
      await git(scratch, "init", "-q", "--bare", "-b", "main", remote);
      await new Deno.Command("cp", { args: ["-r", `${FIXTURES}recipes`, seed] })
        .output();
      for (
        const a of [
          ["init", "-q", "-b", "main"],
          ["add", "."],
          [
            "commit",
            "-q",
            "-m",
            "seed",
          ],
          ["remote", "add", "origin", `file://${remote}`],
          [
            "push",
            "-q",
            "origin",
            "main",
          ],
        ]
      ) await git(seed, ...a);

      for (const pkg of ["change-packet", "github-pr"]) {
        assertEquals(
          (await repo.swamp(["extension", "source", "add", join(ROOT, pkg)]))
            .code,
          0,
        );
      }
      assertEquals(
        (await repo.swamp([
          "extension",
          "pull",
          "@svendowideit/github-release-install",
        ])).code,
        0,
      );
      const create = async (type: string, name: string, ...args: string[]) =>
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
          `${name}`,
        );
      await create(
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
      );
      const archive = join(repo.dir, ".swamp", "mere", "download", "mere");
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
      const sha =
        (download.dataArtifacts as { attributes: { sha256: string } }[])[0]
          .attributes.sha256;
      await create(
        "@jeremy/mere/toolchain",
        "mere",
        "--global-arg",
        "mereVersion=0.23.0",
      );
      await repo.json([
        "behavior",
        "run",
        "mere",
        "provision",
        "--input",
        `archivePath=${archive}`,
        "--input",
        `sha256=${sha}`,
      ]);
      await create(
        "@jeremy/mere/recipe",
        "merelinux",
        "--global-arg",
        `repoUrl=file://${remote}`,
      );
      await create("@jeremy/mere/source", "merelinux-upstream");
      await create("@jeremy/change-packet", "mere-change-packets");
      await create(
        "@jeremy/github-pr",
        "merelinux-pr",
        "--global-arg",
        "repository=jhuntwork/merelinux",
        "--global-arg",
        "baseBranch=main",
        "--global-arg",
        "expectedActor=nobody",
        "--global-arg",
        "authMode=gh",
      );

      assertEquals(
        (await repo.json(["workflow", "validate", "@jeremy/mere/recipe-bump"]))
          .passed,
        true,
      );
      const run = await repo.json([
        "workflow",
        "run",
        "@jeremy/mere/recipe-bump",
        "--input",
        "recipe=core/inih",
        "--input",
        "version=63",
      ]);
      const jobs = run.jobs as {
        name: string;
        status: string;
        steps: { name: string; status: string }[];
      }[];
      const status = (job: string, step: string) =>
        jobs.find((j) => j.name === job)?.steps.find((s) => s.name === step)
          ?.status;
      for (const step of ["scan", "plan"]) {
        assertEquals(status("prepare", step), "succeeded", step);
      }
      for (
        const step of [
          "workspace",
          "clean",
          "worktree",
          "set-version",
          "validate",
          "build",
          "summarize",
        ]
      ) assertEquals(status("build", step), "succeeded", step);
      // It cannot finish: the remote is not on GitHub, so planning the PR fails.
      assertEquals(run.status, "failed");

      // The branch was pushed with one commit that touches only the recipe.
      const files =
        (await git(remote, "diff", "--name-only", "main", "bump-inih-63"))
          .trim();
      assertEquals(files, "recipes/core/inih/recipe.kdl");
      assertEquals(
        (await git(remote, "rev-list", "--count", "main..bump-inih-63")).trim(),
        "1",
      );
      // The commit follows the standards: subject only, no trailers.
      assertEquals(
        (await git(remote, "log", "-1", "--format=%B", "bump-inih-63")).trim(),
        "inih: upgrade to 63",
      );
      const summary = await repo.json([
        "data",
        "query",
        'modelName == "merelinux" && name == "summary-inih" && isLatest',
        "--select",
        "attributes.labels",
      ]);
      assertEquals(summary.results, [["automated", "bump", "needs-migration"]]);
    } finally {
      await repo.cleanup();
      await new Deno.Command("chmod", { args: ["-R", "u+rwX", scratch] })
        .output();
      await Deno.remove(scratch, { recursive: true });
    }
  },
});
