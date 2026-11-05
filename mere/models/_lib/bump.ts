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

const short = (hash: string) => hash.slice(0, 12);

/** Title, commit message, body and labels for a bump PR, from data only. */
export function renderSummary(input: SummaryInput): Summary {
  const { name, change, bump, build } = input;
  const from = change.version.before;
  const to = change.version.after;
  const title = `Upgrade ${name} to ${to}`;
  const labels = ["automated", "bump"];
  if (bump.needsMigration) labels.push("needs-migration");
  const lines: string[] = [
    `Upgrade \`${name}\` from ${from} to ${to} (${bump.bumpKind} update` +
    (change.release.before === change.release.after
      ? `, release ${change.release.after}).`
      : `, release ${change.release.before} → ${change.release.after}).`),
    "",
  ];
  if (bump.needsMigration) {
    const why = [
      bump.bumpKind !== "patch" && bump.bumpKind !== "none"
        ? `this is a ${bump.bumpKind} update`
        : "",
      bump.targetSource === "explicit"
        ? "the version was chosen explicitly"
        : "",
      bump.hardcodedVersion.exact || bump.hardcodedVersion.series
        ? "the recipe's scripts spell out its version or series"
        : "",
    ].filter(Boolean).join("; ");
    lines.push(
      `**Needs migration review:** ${why}. The build passed, but check that ` +
        "nothing else in the recipe or its dependents assumes the old version.",
      "",
    );
  }
  lines.push("## Version", "", `- Current: ${from}`, `- This PR: ${to}`);
  if (bump.latestVersion && bump.latestVersion !== to) {
    lines.push(`- Newest upstream: ${bump.latestVersion}`);
  }
  if (
    bump.latestInSeries && bump.latestInSeries !== to &&
    bump.latestInSeries !== from
  ) {
    lines.push(`- Newest in the current series: ${bump.latestInSeries}`);
  }
  lines.push("", "## Source hashes", "");
  for (const s of change.sources) {
    lines.push(`- \`${s.url}\``);
    lines.push(
      `  - was \`${short(s.blake3Before)}…\`, now \`${short(s.blake3After)}…\``,
    );
  }
  lines.push(
    "",
    "## Build",
    "",
    `Built on ${build.arch}${build.noCache ? " without cache" : ""} in ` +
      `${Math.round(build.durationMs / 1000)} s; \`mere dev validate\` passed.`,
    "",
  );
  for (const o of build.outputs) {
    lines.push(
      `- \`${o.package}\` (${o.bytes} bytes, sha256 \`${short(o.sha256)}…\`)`,
    );
  }
  lines.push("", "## Dependents", "");
  lines.push(
    input.dependents.length === 0
      ? "No other recipe depends on this one."
      : `${input.dependents.length} ${
        input.dependents.length === 1 ? "recipe depends" : "recipes depend"
      } on it: ${input.dependents.map((d) => `\`${d}\``).join(", ")}.`,
  );
  lines.push(
    "",
    "---",
    `Opened by the \`recipe-bump\` workflow (run \`${input.runId}\`). ` +
      "CI on `main` is the authoritative build; this is the local pre-check.",
  );
  return {
    title,
    commitMessage: `${title}\n\n${lines[0]}`,
    body: lines.join("\n"),
    labels,
  };
}
