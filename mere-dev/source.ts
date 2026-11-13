import { z } from "npm:zod@4.1.12";
import { blake3 } from "npm:@noble/hashes@2.0.1/blake3.js";
import { join } from "node:path";
import {
  candidateUrl,
  isNewer,
  type LookupInput,
  lookupLatest,
  RateLimited,
} from "./lib/upstream.ts";
import { runCommand } from "./lib/runner.ts";
import {
  bumpKind,
  compareVersions,
  normalizePatchSuffix,
} from "./lib/versions.ts";

const GlobalArgs = z.object({
  githubToken: z.string().default("").meta({ sensitive: true }).describe(
    "Optional. Falls back to GITHUB_TOKEN, GH_TOKEN, then `gh auth token`.",
  ),
  anityaBaseUrl: z.string().url().default("https://release-monitoring.org"),
});

const FetchHashArgs = z.object({ url: z.string().url() });
const UpstreamSchema = z.object({
  name: z.string(),
  currentVersion: z.string(),
  latestVersion: z.string().optional(),
  latestInSeries: z.string().optional(),
  bumpKind: z.enum(["none", "patch", "minor", "major"]).optional(),
  isNewer: z.boolean(),
  provider: z.enum(["github", "anitya", "none"]),
  projectId: z.number().int().optional(),
  candidateUrl: z.string().optional(),
  note: z.string().optional(),
  checkedAt: z.string(),
  durationMs: z.number().nonnegative(),
  schemaVersion: z.literal(1),
});

const BumpSchema = z.object({
  recipe: z.string(),
  name: z.string(),
  currentVersion: z.string(),
  targetVersion: z.string(),
  targetSource: z.enum(["latestInSeries", "explicit"]),
  bumpKind: z.enum(["none", "patch", "minor", "major"]),
  latestVersion: z.string().optional(),
  latestInSeries: z.string().optional(),
  hardcodedVersion: z.object({ exact: z.boolean(), series: z.boolean() }),
  needsMigration: z.boolean(),
  releaseNotesUrl: z.string().optional(),
  releaseSummary: z.string().optional(),
  branch: z.string(),
  sources: z.array(z.object({
    url: z.string(),
    candidateUrl: z.string(),
    blake3: z.string(),
    bytes: z.number().int().nonnegative(),
  })),
  commit: z.string(),
  durationMs: z.number().nonnegative(),
  schemaVersion: z.literal(1),
});

const PrepareBumpArgs = z.object({
  recipeBinding: z.string().min(1).default("merelinux"),
  recipe: z.string().regex(/^[a-z0-9][a-z0-9._+-]*\/[a-z0-9][a-z0-9._+-]*$/i),
  version: z.string().default("").describe(
    "Empty targets the newest stable release in the recipe's current " +
      "series; set it to move to another version, such as a new series.",
  ),
});

const ArtifactSchema = z.object({
  url: z.string(),
  resolvedUrl: z.string(),
  path: z.string(),
  blake3: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  cached: z.boolean(),
  arch: z.string(),
  os: z.string(),
  durationMs: z.number().nonnegative(),
});

const MAX_REDIRECTS = 5;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Derive the stable cache key for a source URL. */
export async function urlKey(url: string): Promise<string> {
  return hex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)),
    ),
  );
}

function requireHttps(url: string) {
  if (new URL(url).protocol !== "https:") {
    throw new Error("Source URL must use HTTPS");
  }
}

/** Follow redirects by hand so every hop is checked to be HTTPS. */
async function openResponse(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<{ response: Response; resolvedUrl: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    requireHttps(current);
    const response = await fetcher(current, { signal, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      current = new URL(location, current).toString();
      continue;
    }
    return { response, resolvedUrl: current };
  }
  throw new Error(
    `Source download failed: more than ${MAX_REDIRECTS} redirects`,
  );
}

async function hashFile(path: string, signal: AbortSignal) {
  const hash = blake3.create();
  let bytes = 0;
  const file = await Deno.open(path, { read: true });
  try {
    for await (const chunk of file.readable) {
      signal.throwIfAborted();
      hash.update(chunk);
      bytes += chunk.length;
    }
  } catch (error) {
    try {
      file.close();
    } catch { /* The stream may already have closed it. */ }
    throw error;
  }
  return { blake3: hex(hash.digest()), bytes };
}

/** Return the cached artifact for a URL only if its bytes still match. */
async function cachedArtifact(
  url: string,
  directory: string,
  signal: AbortSignal,
) {
  const metaPath = join(directory, "by-url", `${await urlKey(url)}.json`);
  let meta: { blake3: string; resolvedUrl: string };
  try {
    meta = JSON.parse(await Deno.readTextFile(metaPath));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
  if (!/^[a-f0-9]{64}$/.test(meta.blake3)) return undefined;
  const path = join(directory, meta.blake3);
  try {
    const actual = await hashFile(path, signal);
    if (actual.blake3 !== meta.blake3) return undefined;
    return { path, resolvedUrl: meta.resolvedUrl, ...actual };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

/** Download, hash, and atomically cache one HTTPS source artifact. */
export async function downloadArtifact(
  url: string,
  directory: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  requireHttps(url);
  signal.throwIfAborted();
  const started = performance.now();
  await Deno.mkdir(join(directory, "by-url"), { recursive: true });
  const cached = await cachedArtifact(url, directory, signal);
  if (cached) {
    return {
      url,
      resolvedUrl: cached.resolvedUrl,
      path: cached.path,
      blake3: cached.blake3,
      bytes: cached.bytes,
      cached: true,
      arch: Deno.build.arch,
      os: Deno.build.os,
      durationMs: performance.now() - started,
    };
  }
  const { response, resolvedUrl } = await openResponse(url, signal, fetcher);
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Source download failed: HTTP ${response.status}`);
  }
  const temporary = await Deno.makeTempFile({
    dir: directory,
    prefix: "download-",
  });
  const file = await Deno.open(temporary, { write: true });
  let bytes = 0;
  const hash = blake3.create();
  try {
    const reader = response.body.getReader();
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        hash.update(value);
        bytes += value.length;
        let offset = 0;
        while (offset < value.length) {
          offset += await file.write(value.subarray(offset));
        }
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    signal.throwIfAborted();
    const digest = hex(hash.digest());
    file.close();
    const path = join(directory, digest);
    await Deno.rename(temporary, path);
    const metaPath = join(directory, "by-url", `${await urlKey(url)}.json`);
    const metaTemporary = `${metaPath}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(
      metaTemporary,
      JSON.stringify({ blake3: digest, resolvedUrl }),
    );
    await Deno.rename(metaTemporary, metaPath);
    return {
      url,
      resolvedUrl,
      path,
      blake3: digest,
      bytes,
      cached: false,
      arch: Deno.build.arch,
      os: Deno.build.os,
      durationMs: performance.now() - started,
    };
  } catch (error) {
    try {
      file.close();
    } catch { /* Already closed before rename. */ }
    await Deno.remove(temporary).catch((cleanupError) => {
      if (!(cleanupError instanceof Deno.errors.NotFound)) throw cleanupError;
    });
    throw error;
  }
}

const LatestArgs = z.object({
  name: z.string().min(1),
  currentVersion: z.string().min(1),
  url: z.string().default(""),
  sourceUrl: z.string().default(""),
  anityaProjectId: z.number().int().optional(),
});

const ScanLatestArgs = z.object({
  recipeBinding: z.string().min(1).default("merelinux"),
  concurrency: z.number().int().min(1).max(16).default(4),
});

type UpstreamContext = {
  repoDir?: string;
  signal: AbortSignal;
  globalArgs: z.infer<typeof GlobalArgs>;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readModelData: (
    name: string,
    spec?: string,
  ) => Promise<{ attributes: Record<string, unknown> }[]>;
  fetcher?: typeof fetch;
};

/** Explicit token, then GITHUB_TOKEN / GH_TOKEN, then `gh auth token`. */
export async function resolveGithubToken(
  configured: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (configured) return configured;
  const fromEnv = Deno.env.get("GITHUB_TOKEN") || Deno.env.get("GH_TOKEN");
  if (fromEnv) return fromEnv;
  try {
    const result = await runCommand("gh", ["auth", "token"], {
      signal,
      timeoutMs: 10_000,
    });
    const token = result.stdout.trim();
    return result.exitCode === 0 && token ? token : undefined;
  } catch {
    return undefined;
  }
}

async function providersFor(context: UpstreamContext) {
  const globals = GlobalArgs.parse(context.globalArgs);
  return {
    fetcher: context.fetcher ?? fetch,
    githubToken: await resolveGithubToken(globals.githubToken, context.signal),
    anityaBaseUrl: globals.anityaBaseUrl,
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(300_000)]),
  };
}

/** Convert parsed recipe data into an upstream lookup request. */
export function recipeToInput(a: Record<string, unknown>): LookupInput {
  const sources = (a.sources ?? []) as {
    url: string;
    isLocal: boolean;
    interpolatesVersion: boolean;
  }[];
  const remote = sources.filter((s) => !s.isLocal);
  const source = remote.find((s) => s.interpolatesVersion) ?? remote[0];
  return {
    name: String(a.name),
    currentVersion: String(a.version),
    url: String(a.url ?? ""),
    // Resolve the variables that do not change between versions, so tag
    // prefixes can be read off the URL (${recipe.version} stays in place).
    sourceUrl: (source?.url ?? "")
      .replaceAll("${recipe.url}", String(a.url ?? "").replace(/\/+$/, ""))
      .replaceAll("${recipe.name}", String(a.name)),
    ...(a.upstreamOverride
      ? { override: a.upstreamOverride as LookupInput["override"] }
      : {}),
  };
}

async function lookupOne(
  input: LookupInput,
  providers: Awaited<ReturnType<typeof providersFor>>,
  context: UpstreamContext,
  state: { rateLimited: boolean } = { rateLimited: false },
) {
  const started = performance.now();
  let result: Awaited<ReturnType<typeof lookupLatest>>;
  try {
    if (state.rateLimited) {
      result = { provider: "none", note: "skipped: GitHub rate limit reached" };
    } else {
      result = await lookupLatest(input, providers);
    }
  } catch (error) {
    if (error instanceof RateLimited) state.rateLimited = true;
    result = {
      provider: "none",
      note: (error instanceof Error ? error.message : String(error)).slice(
        0,
        300,
      ),
    };
  }
  return await context.writeResource("upstream", `upstream-${input.name}`, {
    name: input.name,
    currentVersion: input.currentVersion,
    ...(result.latestVersion ? { latestVersion: result.latestVersion } : {}),
    ...(result.latestInSeries ? { latestInSeries: result.latestInSeries } : {}),
    ...(result.latestVersion
      ? {
        bumpKind: bumpKind(
          input.currentVersion,
          result.latestVersion,
          input.override?.patchSuffix,
        ),
      }
      : {}),
    isNewer: isNewer(
      input.currentVersion,
      result.latestVersion,
      input.override?.patchSuffix,
    ),
    provider: result.provider,
    ...(result.projectId !== undefined ? { projectId: result.projectId } : {}),
    ...(candidateUrl(input.sourceUrl, result.latestVersion)
      ? { candidateUrl: candidateUrl(input.sourceUrl, result.latestVersion) }
      : {}),
    ...(result.note ? { note: result.note } : {}),
    checkedAt: new Date().toISOString(),
    durationMs: performance.now() - started,
    schemaVersion: 1,
  });
}

/** Behavior that resolves upstream versions and hashes source artifacts. */
export const model = {
  type: "@jeremy/mere-dev/source",
  version: "2026.11.13.5",
  description:
    "Upstream version lookup for merelinux recipes, and source download and hashing for version bumps.",
  upgrades: [{
    toVersion: "2026.11.13.5",
    description:
      "Moved from @jeremy/mere/source to @jeremy/mere-dev/source. Methods, arguments, and resources are unchanged.",
    upgradeAttributes: (
      old: Record<string, unknown>,
    ): Record<string, unknown> => old,
  }],
  globalArguments: GlobalArgs,
  resources: {
    bump: {
      description:
        "What a bump of one recipe will do, with its new source hashes",
      schema: BumpSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    upstream: {
      description: "Latest upstream version of one recipe",
      schema: UpstreamSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    artifact: {
      description: "Downloaded source and its BLAKE3 digest",
      schema: ArtifactSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    prepareBump: {
      description:
        "Decide and prepare a version bump for one recipe: look up upstream, " +
        "pick the target (the newest in the current series unless `version` " +
        "is given), and download and hash every source whose URL carries the " +
        "version. Writes the plan; edits nothing.",
      kind: "read",
      arguments: PrepareBumpArgs,
      execute: async (
        args: z.infer<typeof PrepareBumpArgs>,
        context: UpstreamContext & { repoDir: string },
      ) => {
        const started = performance.now();
        const rel = `recipes/${args.recipe}/recipe.kdl`;
        const records = await context.readModelData(
          args.recipeBinding,
          "recipe",
        );
        const found = records.find((r) => r.attributes.path === rel);
        if (!found) {
          throw new Error(
            `no data for ${args.recipe} in "${args.recipeBinding}"; run its scan first`,
          );
        }
        const a = found.attributes;
        const input = recipeToInput(a);
        const suffix = input.override?.patchSuffix;
        const providers = await providersFor(context);
        const lookup = await lookupLatest(input, providers, {
          includeReleaseSummary: true,
        });
        let targetVersion = args.version;
        let targetSource: "explicit" | "latestInSeries" = "explicit";
        if (!targetVersion) {
          targetSource = "latestInSeries";
          targetVersion = lookup.latestInSeries ?? "";
          if (
            !targetVersion ||
            !isNewer(input.currentVersion, targetVersion, suffix)
          ) {
            throw new Error(
              `${input.name} has nothing newer in its ${input.currentVersion} series` +
                (lookup.latestVersion &&
                    lookup.latestVersion !== input.currentVersion
                  ? `; the newest upstream is ${lookup.latestVersion}, pass version to move to it`
                  : lookup.note
                  ? ` (${lookup.note})`
                  : ""),
            );
          }
        } else if (
          compareVersions(
            normalizePatchSuffix(targetVersion, suffix),
            normalizePatchSuffix(input.currentVersion, suffix),
          ) <= 0
        ) {
          throw new Error(
            `${input.name} is at ${input.currentVersion}; ${targetVersion} is not newer`,
          );
        }
        const raw = (a.sources as {
          url: string;
          isLocal: boolean;
          interpolatesVersion: boolean;
        }[]).filter((x) => !x.isLocal && x.interpolatesVersion);
        const sources = [];
        for (const source of raw) {
          context.signal.throwIfAborted();
          const candidate = source.url
            .replaceAll("${recipe.version}", targetVersion)
            .replaceAll("${recipe.name}", input.name)
            .replaceAll(
              "${recipe.url}",
              String(a.url ?? "").replace(/\/+$/, ""),
            );
          if (candidate.includes("${")) {
            throw new Error(
              `source "${source.url}" uses a variable prepareBump cannot resolve`,
            );
          }
          const artifact = await downloadArtifact(
            candidate,
            join(context.repoDir, ".swamp", "mere", "downloads"),
            AbortSignal.any([context.signal, AbortSignal.timeout(600_000)]),
          );
          sources.push({
            url: source.url,
            candidateUrl: candidate,
            blake3: artifact.blake3,
            bytes: artifact.bytes,
          });
        }
        const releaseNotesUrl = lookup.releaseUrls?.[targetVersion] ??
          lookup.projectUrl;
        const kind = bumpKind(input.currentVersion, targetVersion, suffix);
        const hardcoded = a.hardcodedVersion as {
          exact: boolean;
          series: boolean;
        };
        const handle = await context.writeResource(
          "bump",
          `bump-${input.name}`,
          {
            recipe: args.recipe,
            name: input.name,
            currentVersion: input.currentVersion,
            targetVersion,
            targetSource,
            bumpKind: kind,
            ...(lookup.latestVersion
              ? { latestVersion: lookup.latestVersion }
              : {}),
            ...(lookup.latestInSeries
              ? { latestInSeries: lookup.latestInSeries }
              : {}),
            hardcodedVersion: hardcoded,
            releaseNotesUrl,
            ...(lookup.releaseSummaries?.[targetVersion]
              ? { releaseSummary: lookup.releaseSummaries[targetVersion] }
              : {}),
            needsMigration: kind === "major" || kind === "minor" ||
              targetSource === "explicit" || hardcoded.exact ||
              hardcoded.series,
            branch: `bump-${input.name}-${targetVersion}`.replace(
              /[^A-Za-z0-9._-]/g,
              "-",
            ),
            sources,
            commit: String(a.commit ?? ""),
            durationMs: performance.now() - started,
            schemaVersion: 1,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    latest: {
      description:
        "Find the newest stable upstream version of one recipe: GitHub tags " +
        "(then releases) for github.com sources, else Anitya, matched on the " +
        "recipe homepage to avoid name collisions.",
      kind: "read",
      arguments: LatestArgs,
      execute: async (
        args: z.infer<typeof LatestArgs>,
        context: UpstreamContext,
      ) => {
        const providers = await providersFor(context);
        const handle = await lookupOne(args, providers, context);
        return { dataHandles: [handle] };
      },
    },
    scanLatest: {
      description:
        "Look up the latest upstream version of every recipe in one call " +
        "(fan-out over a recipe binding's scan data), with bounded " +
        "concurrency. A failed lookup is recorded as a note on that " +
        "recipe's upstream resource, never as a failure of the scan.",
      kind: "read",
      arguments: ScanLatestArgs,
      execute: async (
        args: z.infer<typeof ScanLatestArgs>,
        context: UpstreamContext,
      ) => {
        const providers = await providersFor(context);
        const records = await context.readModelData(
          args.recipeBinding,
          "recipe",
        );
        if (records.length === 0) {
          throw new Error(
            `no recipe data in "${args.recipeBinding}"; run its scan first`,
          );
        }
        const inputs = records.map((r) => recipeToInput(r.attributes));
        const handles: { name: string }[] = new Array(inputs.length);
        let next = 0;
        const state = { rateLimited: false };
        await Promise.all(
          Array.from({ length: args.concurrency }, async () => {
            while (next < inputs.length) {
              context.signal.throwIfAborted();
              const index = next++;
              handles[index] = await lookupOne(
                inputs[index],
                providers,
                context,
                state,
              );
            }
          }),
        );
        return { dataHandles: handles };
      },
    },
    fetchHash: {
      description:
        "Download an HTTPS source and compute BLAKE3 without shell commands. HTTPS redirects are followed (max 5); a verified cache is reused by URL.",
      // Read: touches only the scratch download cache, no tracked or remote state.
      kind: "read",
      arguments: FetchHashArgs,
      execute: async (args: z.infer<typeof FetchHashArgs>, context: {
        repoDir: string;
        signal: AbortSignal;
        writeResource: (
          spec: string,
          name: string,
          data: Record<string, unknown>,
        ) => Promise<{ name: string }>;
      }) => {
        const artifact = await downloadArtifact(
          args.url,
          join(context.repoDir, ".swamp", "mere", "downloads"),
          AbortSignal.any([context.signal, AbortSignal.timeout(300_000)]),
        );
        const urlDigest = await urlKey(args.url);
        const handle = await context.writeResource(
          "artifact",
          `artifact-${urlDigest}`,
          artifact,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
