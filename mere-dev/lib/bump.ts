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
    releaseSummary?: string;
  };
  build: {
    arch: string;
    durationMs: number;
    noCache: boolean;
    outputs: { package: string; sha256: string; bytes: number }[];
  };
  dependents: string[];
  /** Changelog entries quoted from the source archive, as markdown. */
  reviewNotes?: string;
}

export interface Summary {
  title: string;
  commitMessage: string;
  body: string;
  labels: string[];
}

/**
 * Title, commit message and one maintainer-facing upstream paragraph for a
 * bump PR. The diff and pipeline carry implementation and check details.
 */
export function renderSummary(input: SummaryInput): Summary {
  const { name, change, bump } = input;
  const to = change.version.after;
  const title = `${name}: upgrade to ${to}`;
  const labels = ["automated", "bump"];
  if (bump.needsMigration) labels.push("needs-migration");
  const releaseUrl = bump.releaseNotesUrl;
  const notes = input.reviewNotes?.trim();
  const upstream = bump.releaseSummary && releaseUrl
    ? `${bump.releaseSummary} Release notes: ${releaseUrl}`
    : releaseUrl
    ? `Release notes: ${releaseUrl}`
    : bump.releaseSummary ?? `Upstream release ${to}.`;
  const body = notes
    ? releaseUrl ? `${notes}\n\nRelease notes: ${releaseUrl}` : notes
    : upstream;
  return {
    title,
    commitMessage: title,
    body,
    labels,
  };
}
