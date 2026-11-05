export interface DependentRecipe {
  name: string;
  depends: string[];
}

/** Recipes whose `depends` name `name` or its `-dev` package. */
export function findDependents(
  recipes: DependentRecipe[],
  name: string,
): string[] {
  const wanted = new Set([name, `${name}-dev`]);
  return recipes.filter((r) =>
    r.name !== name && r.depends.some((d) => wanted.has(d))
  )
    .map((r) => r.name).sort();
}

export interface SummaryInput {
  name: string;
  recipe: string;
  runId: string;
  change: {
    version: { before: string; after: string };
    release: { before: number; after: number };
    sources: { url: string; blake3Before: string; blake3After: string }[];
  };
  bump: {
    bumpKind: string;
    latestVersion?: string;
    latestInSeries?: string;
    targetSource: string;
    needsMigration: boolean;
    hardcodedVersion: { exact: boolean; series: boolean };
    releaseNotesUrl?: string;
  };
  build: {
    arch: string;
    durationMs: number;
    noCache: boolean;
    outputs: { package: string; sha256: string; bytes: number }[];
  };
  dependents: string[];
}

export interface Summary {
  title: string;
  commitMessage: string;
  body: string;
  labels: string[];
}

/**
 * Title, commit message, body and labels for a bump PR, from data only.
 *
 * The diff already shows the version, release and hash, so the body carries
 * only what the diff cannot: where to read what changed upstream, whether the
 * bump needs a closer look and why, who depends on the recipe, and the local
 * evidence that it validated and built.
 */
export function renderSummary(input: SummaryInput): Summary {
  const { name, change, bump, build } = input;
  const from = change.version.before;
  const to = change.version.after;
  // The same subject for the commit and the PR title, in merelinux's
  // `<name>: <verb phrase>` style.
  const title = `${name}: upgrade to ${to}`;
  const labels = ["automated", "bump"];
  if (bump.needsMigration) labels.push("needs-migration");
  const blocks: string[] = [];
  if (bump.needsMigration) {
    const why = [
      bump.bumpKind !== "patch" && bump.bumpKind !== "none"
        ? `this is a ${bump.bumpKind} update (${from} → ${to})`
        : "",
      bump.targetSource === "explicit"
        ? "the version was chosen explicitly"
        : "",
      bump.hardcodedVersion.exact || bump.hardcodedVersion.series
        ? "the recipe's scripts spell out its version or series"
        : "",
    ].filter(Boolean).join("; ");
    const newer = [
      bump.latestVersion && bump.latestVersion !== to
        ? `Newest upstream: ${bump.latestVersion}.`
        : "",
      bump.latestInSeries && bump.latestInSeries !== to &&
        bump.latestInSeries !== from
        ? `Newest in the current series: ${bump.latestInSeries}.`
        : "",
    ].filter(Boolean).join(" ");
    blocks.push(
      `**Needs migration review:** ${why}. Check that nothing else in the ` +
        `recipe or its dependents assumes the old version.` +
        (newer ? ` ${newer}` : ""),
    );
  }
  if (bump.releaseNotesUrl) {
    blocks.push(`Release notes: ${bump.releaseNotesUrl}`);
  }
  const evidence = [`Built and validated locally on ${build.arch}.`];
  if (input.dependents.length > 0) {
    evidence.push(
      `Dependents: ${input.dependents.map((d) => `\`${d}\``).join(", ")}.`,
    );
  }
  blocks.push(evidence.join(" "));
  blocks.push(`Opened by recipe-bump (run \`${input.runId}\`).`);
  return {
    title,
    commitMessage: title,
    body: blocks.join("\n\n"),
    labels,
  };
}
