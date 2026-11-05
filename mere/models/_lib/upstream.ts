import {
  compareVersions,
  inferTagPrefix,
  isPrerelease,
  newestStable,
  normalizePatchSuffix,
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
  override?: {
    anityaProjectId?: number;
    github?: string;
    tagPrefix?: string;
    exclude?: string[];
    patchSuffix?: string;
  };
}

export interface Lookup {
  provider: "github" | "anitya" | "none";
  latestVersion?: string;
  /** Newest stable version in the current version's series (first two segments). */
  latestInSeries?: string;
  projectId?: number;
  /** Release page per version (GitHub), by the tag that produced it. */
  releaseUrls?: Record<string, string>;
  /** The project's page, when there is no per-version page (Anitya). */
  projectUrl?: string;
  note?: string;
}

/** Newest overall and newest within the current series, from all stable versions. */
export function pickLatest(
  versions: string[],
  currentVersion: string,
  override: LookupInput["override"] = {},
): { latestVersion?: string; latestInSeries?: string } {
  const excluded = (override.exclude ?? []).map((p) => new RegExp(p));
  const kept = versions.filter((v) => !excluded.some((re) => re.test(v)));
  const suffix = override.patchSuffix;
  const latestVersion = newestStable(kept, suffix);
  const series = seriesOf(normalizePatchSuffix(currentVersion, suffix));
  const latestInSeries = newestStable(
    kept.filter((v) => seriesOf(normalizePatchSuffix(v, suffix)) === series),
    suffix,
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
  const prefixes = input.override?.tagPrefix !== undefined
    ? [input.override.tagPrefix]
    : [...new Set([inferTagPrefix(input.sourceUrl), "v", ""])]
      .filter((p): p is string => p !== undefined);
  const tagNames =
    ((await getJson(`${base}/tags?per_page=100`, providers, headers)) as {
      name: string;
    }[]).map((t) => t.name);
  const urlFor = (tag: string) =>
    `https://github.com/${repo.owner}/${repo.repo}/releases/tag/${
      encodeURIComponent(tag)
    }`;
  for (const prefix of prefixes) {
    const urls: Record<string, string> = {};
    const versions = tagNames.flatMap((tag) => {
      const v = versionFromTag(tag, prefix, input.currentVersion);
      if (v !== undefined) urls[v] = urlFor(tag);
      return v === undefined ? [] : [v];
    });
    const picked = pickLatest(versions, input.currentVersion, input.override);
    if (picked.latestVersion) {
      return { provider: "github", ...picked, releaseUrls: urls };
    }
  }
  const releases = ((await getJson(
    `${base}/releases?per_page=30`,
    providers,
    headers,
  )) as { tag_name: string; prerelease: boolean; draft: boolean }[])
    .filter((r) => !r.prerelease && !r.draft);
  for (const prefix of prefixes) {
    const urls: Record<string, string> = {};
    const versions = releases.flatMap((r) => {
      const v = versionFromTag(r.tag_name, prefix, input.currentVersion);
      if (v !== undefined) urls[v] = urlFor(r.tag_name);
      return v === undefined ? [] : [v];
    });
    const picked = pickLatest(versions, input.currentVersion, input.override);
    if (picked.latestVersion) {
      return { provider: "github", ...picked, releaseUrls: urls };
    }
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

const hasVersion = (project: AnityaProject, current: string) =>
  [...(project.versions ?? []), ...(project.stable_versions ?? [])].some((v) =>
    v === current || v.replace(/^v/i, "") === current
  );

/**
 * Pick the Anitya project for a recipe. The homepage often differs from the
 * recipe's `url` (openssl: openssl-library.org vs www.openssl.org), and the
 * name is shared with crates.io, PyPI and other registries. The strongest
 * evidence is that the project already lists the version the recipe has.
 */
export function chooseProject(
  items: AnityaProject[],
  input: LookupInput,
): { project: AnityaProject } | { note: string } {
  const sameHomepage = (p: AnityaProject) =>
    normalizeUrl(p.homepage) === normalizeUrl(input.url);
  const confirmed = items.filter((p) => hasVersion(p, input.currentVersion));
  if (confirmed.length === 1) return { project: confirmed[0] };
  if (confirmed.length > 1) {
    const byHomepage = confirmed.filter(sameHomepage);
    if (byHomepage.length === 1) return { project: byHomepage[0] };
    return {
      note:
        `${confirmed.length} Anitya projects named ${input.name} list ${input.currentVersion} ` +
        `(ids ${confirmed.map((p) => p.id).join(", ")}); set anityaProjectId`,
    };
  }
  const byHomepage = items.filter(sameHomepage);
  if (byHomepage.length === 1) return { project: byHomepage[0] };
  if (byHomepage.length > 1) {
    return {
      note:
        `${byHomepage.length} Anitya projects match ${input.name} by homepage; set anityaProjectId`,
    };
  }
  return {
    note: items.length === 0
      ? `no Anitya project named ${input.name}`
      : `no Anitya project named ${input.name} lists ${input.currentVersion} or has homepage ${input.url} ` +
        `(candidates: ${items.map((p) => `${p.id} ${p.homepage}`).join("; ")})`,
  };
}

async function anityaLatest(
  input: LookupInput,
  providers: Providers,
): Promise<Lookup> {
  const base = providers.anityaBaseUrl.replace(/\/+$/, "");
  let project: AnityaProject | undefined;
  if (input.anityaProjectId !== undefined) {
    // There is no single-project endpoint; the versions endpoint is keyed by id.
    const versions = (await getJson(
      `${base}/api/v2/versions/?project_id=${input.anityaProjectId}`,
      providers,
    )) as { versions?: string[]; stable_versions?: string[] };
    project = {
      id: input.anityaProjectId,
      name: input.name,
      homepage: input.url,
      versions: versions.versions,
      stable_versions: versions.stable_versions,
    };
  } else {
    const search = (await getJson(
      `${base}/api/v2/projects/?name=${encodeURIComponent(input.name)}`,
      providers,
    )) as { items: AnityaProject[] };
    const chosen = chooseProject(search.items, input);
    if ("note" in chosen) return { provider: "anitya", note: chosen.note };
    project = chosen.project;
  }
  const candidates = project.stable_versions ?? project.versions ?? [];
  const picked = pickLatest(candidates, input.currentVersion, input.override);
  return picked.latestVersion
    ? {
      provider: "anitya",
      projectId: project.id,
      ...picked,
      projectUrl: `https://release-monitoring.org/project/${project.id}/`,
    }
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
  const override = input.override ?? {};
  const projectId = override.anityaProjectId ?? input.anityaProjectId;
  if (override.github) {
    const [owner, repo] = override.github.split("/");
    return await githubLatest(input, { owner, repo }, providers);
  }
  if (projectId !== undefined) {
    return await anityaLatest(
      { ...input, anityaProjectId: projectId },
      providers,
    );
  }
  const repo = githubRepo(input.sourceUrl, input.url);
  if (repo) return await githubLatest(input, repo, providers);
  return await anityaLatest(input, providers);
}

export function isNewer(
  current: string,
  latest: string | undefined,
  patchSuffix?: string,
): boolean {
  if (latest === undefined) return false;
  const lat = normalizePatchSuffix(latest, patchSuffix);
  return !isPrerelease(lat) &&
    compareVersions(lat, normalizePatchSuffix(current, patchSuffix)) > 0;
}

/** Replace ${recipe.version} so the candidate download URL can be fetched. */
export function candidateUrl(
  sourceUrl: string,
  latest: string | undefined,
): string | undefined {
  if (!latest || !sourceUrl.includes("${recipe.version}")) return undefined;
  return sourceUrl.replaceAll("${recipe.version}", latest);
}
