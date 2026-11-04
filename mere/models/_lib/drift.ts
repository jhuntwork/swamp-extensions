export interface UpstreamRecord {
  name: string;
  currentVersion: string;
  latestVersion?: string;
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

export function summarizeDrift(
  records: UpstreamRecord[],
  scan?: ScanSummary,
): Drift {
  const behind = records.filter((r) => r.isNewer).sort(byName);
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
  if (drift.behind.length === 0) lines.push("None.");
  else {
    lines.push(
      "| Recipe | Current | Latest | Provider |",
      "| --- | --- | --- | --- |",
    );
    for (const r of drift.behind) {
      lines.push(
        `| ${cell(r.name)} | ${cell(r.currentVersion)} | ${
          cell(r.latestVersion ?? "")
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
