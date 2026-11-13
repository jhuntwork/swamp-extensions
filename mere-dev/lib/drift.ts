import { compareVersions } from "./versions.ts";

export interface UpstreamRecord {
  name: string;
  currentVersion: string;
  latestVersion?: string;
  latestInSeries?: string;
  bumpKind?: string;
  isNewer: boolean;
  provider: string;
  note?: string;
  candidateUrl?: string;
}

export interface ScanSummary {
  commit?: string;
  total?: number;
  parsed?: number;
  failures?: { path: string; error: string }[];
  normalized?: string[];
  hardcodedVersion?: string[];
}

export interface Drift {
  total: number;
  behind: UpstreamRecord[];
  current: number;
  unresolved: UpstreamRecord[];
  byProvider: Record<string, { found: number; behind: number }>;
  scan?: ScanSummary;
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name);

const KIND_RANK: Record<string, number> = { major: 0, minor: 1, patch: 2 };
const byKind = (a: UpstreamRecord, b: UpstreamRecord) =>
  (KIND_RANK[a.bumpKind ?? ""] ?? 3) - (KIND_RANK[b.bumpKind ?? ""] ?? 3) ||
  byName(a, b);

export function summarizeDrift(
  records: UpstreamRecord[],
  scan?: ScanSummary,
): Drift {
  const behind = records.filter((r) => r.isNewer).sort(byKind);
  const unresolved = records.filter((r) => !r.latestVersion).sort(byName);
  const byProvider: Drift["byProvider"] = {};
  for (const r of records) {
    const entry = byProvider[r.provider] ??= { found: 0, behind: 0 };
    if (r.latestVersion) entry.found++;
    if (r.isNewer) entry.behind++;
  }
  return {
    total: records.length,
    behind,
    current: records.length - behind.length - unresolved.length,
    unresolved,
    byProvider,
    scan,
  };
}

const cell = (text: string) =>
  text.replaceAll("|", "\\|").replaceAll("\n", " ");

export function driftMarkdown(drift: Drift): string {
  const lines = ["# Upstream drift", ""];
  lines.push(
    `${drift.total} recipes checked: **${drift.behind.length} behind upstream**, ` +
      `${drift.current} current, ${drift.unresolved.length} unresolved.` +
      (drift.scan?.commit
        ? ` Tree commit \`${drift.scan.commit.slice(0, 10)}\`.`
        : ""),
    "",
  );
  lines.push("| Provider | Resolved | Behind |", "| --- | ---: | ---: |");
  for (const [provider, n] of Object.entries(drift.byProvider).sort()) {
    lines.push(`| ${provider} | ${n.found} | ${n.behind} |`);
  }
  lines.push("", "## Behind upstream", "");
  const hardcoded = new Set(drift.scan?.hardcodedVersion ?? []);
  if (drift.behind.length === 0) lines.push("None.");
  else {
    lines.push(
      "Newest stable version overall, never filtered by whether the recipe is " +
        "ready for it. *Newest in series* is the newest stable release of the " +
        "current major.minor line, when it differs. *Hardcoded* marks recipes " +
        "whose scripts spell out their version instead of `${recipe.version}`.",
      "",
      "| Recipe | Current | Latest | Kind | Newest in series | Hardcoded | Provider |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const r of drift.behind) {
      // Only show it when it is a real, different step from both ends.
      const inSeries =
        r.latestInSeries && r.latestInSeries !== r.latestVersion &&
          compareVersions(r.latestInSeries, r.currentVersion) > 0
          ? r.latestInSeries
          : "";
      lines.push(
        `| ${cell(r.name)} | ${cell(r.currentVersion)} | ${
          cell(r.latestVersion ?? "")
        } | ${r.bumpKind ?? ""} | ${cell(inSeries)} | ${
          hardcoded.has(r.name) ? "yes" : ""
        } | ${r.provider} |`,
      );
    }
  }
  lines.push("", "## Unresolved", "");
  if (drift.unresolved.length === 0) lines.push("None.");
  else {
    lines.push("| Recipe | Current | Why |", "| --- | --- | --- |");
    for (const r of drift.unresolved) {
      lines.push(
        `| ${cell(r.name)} | ${cell(r.currentVersion)} | ${
          cell(r.note ?? "no answer")
        } |`,
      );
    }
  }
  const failures = drift.scan?.failures ?? [];
  if (failures.length > 0) {
    lines.push("", "## Recipes that failed to parse", "");
    for (const f of failures) lines.push(`- \`${f.path}\`: ${cell(f.error)}`);
  }
  if (hardcoded.size > 0) {
    lines.push(
      "",
      "## Recipes that hardcode their version",
      "",
      "These recipes spell out their current version or major.minor series in " +
        "a script, so changing `version` alone leaves stale text behind. " +
        "Improving them (with `${recipe.version}`) makes upgrades safe.",
      "",
      ...[...hardcoded].sort().map((n) => `- ${n}`),
    );
  }
  const normalized = drift.scan?.normalized ?? [];
  if (normalized.length > 0) {
    lines.push(
      "",
      "## Recipes mere accepts but strict KDL rejects",
      "",
      ...normalized.map((p) => `- \`${p}\``),
    );
  }
  return lines.join("\n") + "\n";
}
