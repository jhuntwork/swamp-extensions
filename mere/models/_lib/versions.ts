/** Version comparison and tag parsing, RPM-style: numbers beat letters. */

type Segment = { numeric: boolean; value: string };

function segments(version: string): Segment[] {
  const out: Segment[] = [];
  for (const part of version.split(/[^A-Za-z0-9]+/).filter(Boolean)) {
    for (const piece of part.match(/\d+|[A-Za-z]+/g) ?? []) {
      out.push({ numeric: /^\d/.test(piece), value: piece });
    }
  }
  return out;
}

/** Negative if a < b, zero if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const x = segments(a);
  const y = segments(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const left = x[i];
    const right = y[i];
    if (!left) return right.numeric ? -1 : 1;
    if (!right) return left.numeric ? 1 : -1;
    if (left.numeric && right.numeric) {
      const diff = BigInt(left.value) - BigInt(right.value);
      if (diff !== 0n) return diff < 0n ? -1 : 1;
    } else if (left.numeric !== right.numeric) {
      return left.numeric ? 1 : -1;
    } else if (left.value !== right.value) {
      return left.value < right.value ? -1 : 1;
    }
  }
  return 0;
}

const PRERELEASE =
  /(^|[^A-Za-z])(alpha|beta|rc|pre|preview|dev|snapshot|nightly|canary|devel|init|test|milestone)(\d|[^A-Za-z]|$)/i;
const PYTHON_PRE = /\d(a|b|c|rc)\d+$/i;

export function isPrerelease(version: string): boolean {
  return PRERELEASE.test(version) || PYTHON_PRE.test(version);
}

/** The candidates' newest stable version, or undefined. */
export function newestStable(versions: string[]): string | undefined {
  const stable = versions.filter((v) => !isPrerelease(v));
  stable.sort(compareVersions);
  return stable.at(-1);
}

/** Version text of a tag given its prefix, or undefined when it is not one. */
export function versionFromTag(
  tag: string,
  prefix: string,
  currentVersion: string,
): string | undefined {
  if (!tag.startsWith(prefix)) return undefined;
  let rest = tag.slice(prefix.length);
  if (!/^\d/.test(rest)) return undefined;
  if (
    !rest.includes(".") && rest.includes("_") && currentVersion.includes(".")
  ) {
    rest = rest.replaceAll("_", ".");
  }
  return rest;
}

/**
 * The tag prefix a recipe's source URL implies, e.g. "v" for
 * .../tags/v${recipe.version}.tar.gz; undefined when it has none.
 */
export function inferTagPrefix(sourceUrl: string): string | undefined {
  const marker = "${recipe.version}";
  for (const segment of sourceUrl.split("/").slice(3)) {
    const at = segment.indexOf(marker);
    if (at < 0) continue;
    const prefix = segment.slice(0, at);
    return /^[A-Za-z0-9._-]*$/.test(prefix) ? prefix : undefined;
  }
  return undefined;
}
