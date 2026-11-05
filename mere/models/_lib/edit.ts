import { createHash } from "node:crypto";
import { type ParsedRecipe, parseRecipe } from "./kdl.ts";

export interface SetVersionOptions {
  version: string;
  release?: number;
  /** New BLAKE3 for each remote source, by the source's URL as written. */
  hashes: Record<string, string>;
  /** Proceed even when scripts spell out the version (the PR is then flagged). */
  allowHardcodedVersion?: boolean;
}

export interface Change {
  version: { before: string; after: string };
  release: { before: number; after: number };
  sources: { url: string; blake3Before: string; blake3After: string }[];
  fileSha256Before: string;
  fileSha256After: string;
  hardcodedVersion: { exact: boolean; series: boolean };
}

const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+~-]*$/;
const HASH = /^[a-f0-9]{64}$/;
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** Index of the first line at column 0 that is exactly "}", from `from`. */
function blockEnd(lines: string[], from: number): number {
  for (let i = from + 1; i < lines.length; i++) {
    if (lines[i] === "}") return i;
  }
  throw new Error("unterminated block");
}

function replaceInRange(
  lines: string[],
  start: number,
  end: number,
  pattern: RegExp,
  replace: (match: RegExpMatchArray) => string,
  what: string,
): void {
  const hits: number[] = [];
  for (let i = start; i <= end; i++) {
    if (pattern.test(lines[i])) hits.push(i);
  }
  if (hits.length !== 1) {
    throw new Error(`expected exactly one ${what} line, found ${hits.length}`);
  }
  const match = lines[hits[0]].match(pattern)!;
  lines[hits[0]] = replace(match);
}

/**
 * Move a recipe to a new version by editing only the version line, the release
 * line and each affected source's blake3 line. Every other byte is preserved.
 * The result is re-parsed and checked against what was asked for.
 */
export function setVersion(
  text: string,
  relPath: string,
  options: SetVersionOptions,
): { text: string; change: Change } {
  if (!VERSION.test(options.version)) {
    throw new Error(`invalid version "${options.version}"`);
  }
  const before = parseRecipe(text, relPath);
  if (before.version === options.version) {
    throw new Error(`${before.name} is already at ${options.version}`);
  }
  const release = options.release ?? 1;
  if (!Number.isInteger(release) || release < 0) {
    throw new Error("release must be a non-negative integer");
  }
  if (
    (before.hardcodedVersion.exact || before.hardcodedVersion.series) &&
    !options.allowHardcodedVersion
  ) {
    throw new Error(
      `${before.name} spells out its version in a script ` +
        `(${
          JSON.stringify(before.hardcodedVersion)
        }); changing version alone would ` +
        `leave stale text. Improve the recipe to use \${recipe.version}, or ` +
        `pass allowHardcodedVersion to proceed knowingly.`,
    );
  }

  // Which sources need a new hash: remote ones whose URL carries the version.
  const needing = before.sources
    .map((source, index) => ({ source, index }))
    .filter(({ source }) => !source.isLocal && source.interpolatesVersion);
  const known = new Set(before.sources.map((s) => s.url));
  for (const [url, hash] of Object.entries(options.hashes)) {
    if (!known.has(url)) {
      throw new Error(`no source "${url}" in ${before.name}`);
    }
    if (!HASH.test(hash)) throw new Error(`invalid BLAKE3 for "${url}"`);
  }
  for (const { source } of needing) {
    if (!options.hashes[source.url]) {
      throw new Error(`no new BLAKE3 supplied for source "${source.url}"`);
    }
  }
  const urlCounts = new Map<string, number>();
  for (const { source } of needing) {
    urlCounts.set(source.url, (urlCounts.get(source.url) ?? 0) + 1);
  }
  for (const [url, n] of urlCounts) {
    if (n > 1) throw new Error(`source "${url}" appears ${n} times`);
  }

  const lines = text.split("\n");
  const recipeStart = lines.findIndex((l) => /^recipe\s*\{/.test(l));
  if (recipeStart < 0) throw new Error("no recipe block");
  const recipeEnd = blockEnd(lines, recipeStart);
  replaceInRange(
    lines,
    recipeStart,
    recipeEnd,
    /^(\s*version\s+)"[^"]*"(.*)$/,
    (m) => `${m[1]}"${options.version}"${m[2]}`,
    "version",
  );
  replaceInRange(
    lines,
    recipeStart,
    recipeEnd,
    /^(\s*release\s+)\d+(.*)$/,
    (m) => `${m[1]}${release}${m[2]}`,
    "release",
  );

  const sourceStarts = lines.flatMap((l, i) => /^source\b/.test(l) ? [i] : []);
  if (sourceStarts.length !== before.sources.length) {
    throw new Error("could not match source blocks to the parsed sources");
  }
  const changes: Change["sources"] = [];
  for (const { source, index } of needing) {
    const start = sourceStarts[index];
    if (!/\{\s*$/.test(lines[start])) {
      throw new Error(`source "${source.url}" has no block to hold a blake3`);
    }
    const end = blockEnd(lines, start);
    replaceInRange(
      lines,
      start,
      end,
      /^(\s*blake3\s+)"[^"]*"(.*)$/,
      (m) => `${m[1]}"${options.hashes[source.url]}"${m[2]}`,
      `blake3 for "${source.url}"`,
    );
    changes.push({
      url: source.url,
      blake3Before: source.blake3 ?? "",
      blake3After: options.hashes[source.url],
    });
  }

  const after = lines.join("\n");
  const check = parseRecipe(after, relPath);
  assertOnlyExpectedChanges(before, check, options, release, changes);
  return {
    text: after,
    change: {
      version: { before: before.version, after: options.version },
      release: { before: before.release, after: release },
      sources: changes,
      fileSha256Before: sha256(text),
      fileSha256After: sha256(after),
      hardcodedVersion: before.hardcodedVersion,
    },
  };
}

/** The edited recipe must differ from the original only where we meant it to. */
function assertOnlyExpectedChanges(
  before: ParsedRecipe,
  after: ParsedRecipe,
  options: SetVersionOptions,
  release: number,
  changes: Change["sources"],
) {
  const expected = structuredClone(before) as ParsedRecipe;
  expected.version = options.version;
  expected.release = release;
  const newHash = new Map(changes.map((c) => [c.url, c.blake3After]));
  expected.sources = expected.sources.map((s) => {
    const hash = newHash.get(s.url);
    return {
      ...s,
      resolvedUrl: s.resolvedUrl.replaceAll(before.version, options.version),
      ...(hash ? { blake3: hash } : {}),
    };
  });
  const strip = (r: ParsedRecipe) => ({
    ...r,
    sha256OfFile: "",
    // Derived from the version text, so it legitimately changes with it.
    hardcodedVersion: undefined,
    sources: r.sources.map(({ resolvedUrl: _unused, ...rest }) => rest),
  });
  const a = JSON.stringify(strip(expected));
  const b = JSON.stringify(strip(after));
  if (a !== b) {
    throw new Error(
      "the edited recipe differs from the original in more than version, " +
        "release and the new hashes; refusing to write it",
    );
  }
}
