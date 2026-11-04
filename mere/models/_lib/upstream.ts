import {
  compareVersions,
  inferTagPrefix,
  isPrerelease,
  newestStable,
  seriesOf,
  versionFromTag,
} from "./versions.ts";

export interface LookupInput {
  name: string;
  currentVersion: string;
  /** The recipe's homepage (recipe `url`). */
  url: string;
  /** The first remote source URL, still containing ${recipe.version}. */
  sourceUrl: string;
  anityaProjectId?: number;
}

export interface Lookup {
  provider: "github" | "anitya" | "none";
  latestVersion?: string;
  /** Newest stable version in the current version's series (first two segments). */
  latestInSeries?: string;
  projectId?: number;
  note?: string;
}

/** Newest overall and newest within the current series, from all stable versions. */
export function pickLatest(
  versions: string[],
  currentVersion: string,
): { latestVersion?: string; latestInSeries?: string } {
  const latestVersion = newestStable(versions);
  const series = seriesOf(currentVersion);
  const latestInSeries = newestStable(
    versions.filter((v) => seriesOf(v) === series),
  );
  return {
    ...(latestVersion ? { latestVersion } : {}),
    ...(latestInSeries ? { latestInSeries } : {}),
  };
}

export interface Providers {
  fetcher: typeof fetch;
  githubToken?: string;
  anityaBaseUrl: string;
  signal: AbortSignal;
  /** Per-request cap so one stalled request costs one recipe, not the scan. */
  requestTimeoutMs?: number;
}

export class RateLimited extends Error {}

const GITHUB_REPO =
  /^https:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?]|$)/;

export function githubRepo(
  ...urls: string[]
): { owner: string; repo: string } | undefined {
  for (const url of urls) {
    const match = GITHUB_REPO.exec(url);
    if (match) return { owner: match[1], repo: match[2] };
  }
  return undefined;
}

async function getJson(
  url: string,
  providers: Providers,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const timeoutMs = providers.requestTimeoutMs ?? 20_000;
  let response: Response;
  try {
    response = await providers.fetcher(url, {
      headers: {
        accept: "application/json",
        "user-agent": "swamp-mere",
        ...headers,
      },
      signal: AbortSignal.any([
        providers.signal,
        AbortSignal.timeout(timeoutMs),
      ]),
      redirect: "follow",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(
        `request to ${new URL(url).host} timed out after ${timeoutMs}ms`,
      );
    }
    throw error;
  }
  if (
    (response.status === 403 || response.status === 429) &&
    response.headers.get("x-ratelimit-remaining") === "0"
  ) {
    await response.body?.cancel();
    throw new RateLimited(`rate limited by ${new URL(url).host}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return await response.json();
}

function githubHeaders(providers: Providers): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    ...(providers.githubToken
      ? { authorization: `Bearer ${providers.githubToken}` }
      : {}),
  };
}

async function githubLatest(
  input: LookupInput,
  repo: { owner: string; repo: string },
  providers: Providers,
): Promise<Lookup> {
  const base = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;
  const headers = githubHeaders(providers);
  const prefixes = [...new Set([inferTagPrefix(input.sourceUrl), "v", ""])]
    .filter((p): p is string => p !== undefined);
  const tagNames =
    ((await getJson(`${base}/tags?per_page=100`, providers, headers)) as {
      name: string;
    }[]).map((t) => t.name);
  for (const prefix of prefixes) {
    const versions = tagNames.flatMap((tag) => {
      const v = versionFromTag(tag, prefix, input.currentVersion);
      return v === undefined ? [] : [v];
    });
    const picked = pickLatest(versions, input.currentVersion);
    if (picked.latestVersion) return { provider: "github", ...picked };
  }
  const releases = ((await getJson(
    `${base}/releases?per_page=30`,
    providers,
    headers,
  )) as { tag_name: string; prerelease: boolean; draft: boolean }[])
    .filter((r) => !r.prerelease && !r.draft);
  for (const prefix of prefixes) {
    const versions = releases.flatMap((r) => {
      const v = versionFromTag(r.tag_name, prefix, input.currentVersion);
      return v === undefined ? [] : [v];
    });
    const picked = pickLatest(versions, input.currentVersion);
    if (picked.latestVersion) return { provider: "github", ...picked };
  }
  return {
    provider: "github",
    note: `no stable tag or release matched (tried prefixes ${
      JSON.stringify(prefixes)
    })`,
  };
}

interface AnityaProject {
  id: number;
  name: string;
  homepage: string;
  versions?: string[];
  stable_versions?: string[];
}

function normalizeUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(
    /\/+$/,
    "",
  )
    .toLowerCase();
}

async function anityaLatest(
  input: LookupInput,
  providers: Providers,
): Promise<Lookup> {
  const base = providers.anityaBaseUrl.replace(/\/+$/, "");
  let project: AnityaProject | undefined;
  if (input.anityaProjectId !== undefined) {
    project = (await getJson(
      `${base}/api/v2/projects/${input.anityaProjectId}/`,
      providers,
    )) as AnityaProject;
  } else {
    const search = (await getJson(
      `${base}/api/v2/projects/?name=${encodeURIComponent(input.name)}`,
      providers,
    )) as { items: AnityaProject[] };
    // Matching on homepage prevents name collisions (glib vs crates.io).
    const matches = search.items.filter((p) =>
      normalizeUrl(p.homepage) === normalizeUrl(input.url)
    );
    if (matches.length !== 1) {
      return {
        provider: "anitya",
        note: matches.length === 0
          ? `no Anitya project named ${input.name} has homepage ${input.url}`
          : `${matches.length} Anitya projects match ${input.name}; set anityaProjectId`,
      };
    }
    project = matches[0];
  }
  const candidates = project.stable_versions ?? project.versions ?? [];
  const picked = pickLatest(candidates, input.currentVersion);
  return picked.latestVersion
    ? { provider: "anitya", projectId: project.id, ...picked }
    : {
      provider: "anitya",
      projectId: project.id,
      note: "Anitya has no stable version for this project",
    };
}

export async function lookupLatest(
  input: LookupInput,
  providers: Providers,
): Promise<Lookup> {
  const repo = input.anityaProjectId === undefined
    ? githubRepo(input.sourceUrl, input.url)
    : undefined;
  if (repo) return await githubLatest(input, repo, providers);
  return await anityaLatest(input, providers);
}

export function isNewer(current: string, latest: string | undefined): boolean {
  return latest !== undefined && !isPrerelease(latest) &&
    compareVersions(latest, current) > 0;
}

/** Replace ${recipe.version} so the candidate download URL can be fetched. */
export function candidateUrl(
  sourceUrl: string,
  latest: string | undefined,
): string | undefined {
  if (!latest || !sourceUrl.includes("${recipe.version}")) return undefined;
  return sourceUrl.replaceAll("${recipe.version}", latest);
}
