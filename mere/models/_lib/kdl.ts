import { parse } from "npm:@bgotink/kdl@0.4.1/v1-compat";
import { createHash } from "node:crypto";

export interface RecipeSource {
  url: string;
  resolvedUrl: string;
  isLocal: boolean;
  interpolatesVersion: boolean;
  blake3?: string;
  saveAs?: string;
}

export interface ParsedRecipe {
  path: string;
  category: string;
  name: string;
  version: string;
  release: number;
  description: string;
  url: string;
  licenses: string[];
  archs: string[];
  depends: string[];
  env: Record<string, string>;
  needsRoot: boolean;
  sources: RecipeSource[];
  packages: { name: string; hasService: boolean; hasRealizer: boolean }[];
  phases: string[];
  sha256OfFile: string;
  normalized: boolean;
  /**
   * The recipe's scripts spell out its current version (or its major.minor
   * series) instead of using ${recipe.version}: a sign the recipe needs
   * improving before the version can change safely.
   */
  hardcodedVersion: { exact: boolean; series: boolean };
}

type Node = ReturnType<typeof parse>["nodes"][number];

const PHASES = ["prepare", "build", "install", "check"];

function collectStrings(node: Node, out: string[]) {
  for (const value of node.getArguments()) {
    if (typeof value === "string") out.push(value);
  }
  for (const [, value] of node.getProperties()) {
    if (typeof value === "string") out.push(value);
  }
  for (const child of node.children?.nodes ?? []) collectStrings(child, out);
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does `text` contain `needle` as a whole version, not part of a longer number? */
function mentionsVersion(text: string, needle: string): boolean {
  return new RegExp(`(?<!\\d)(?<!\\d\\.)${escape(needle)}(?![\\d])`).test(text);
}

export function findHardcodedVersion(
  scripts: string[],
  version: string,
): { exact: boolean; series: boolean } {
  const text = scripts.join("\n");
  const parts = version.match(/\d+/g) ?? [];
  const series = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : "";
  return {
    exact: version.includes(".") && mentionsVersion(text, version),
    series: series !== "" && series !== version &&
      mentionsVersion(text, series),
  };
}

/**
 * Some recipes end a continued list with a backslash before the closing brace,
 * which strict KDL rejects. Drop it and record that we did.
 */
export function normalizeContinuations(
  text: string,
): { text: string; normalized: boolean } {
  const fixed = text.replace(/\\[ \t]*\n(\s*})/g, "\n$1");
  return { text: fixed, normalized: fixed !== text };
}

function children(node: Node, name: string): Node[] {
  return (node.children?.nodes ?? []).filter((n) => n.getName() === name);
}

function strings(nodes: Node[]): string[] {
  return nodes.flatMap((n) => n.getArguments().map(String));
}

function first(node: Node, name: string): string | undefined {
  const found = children(node, name)[0]?.getArguments()[0];
  return found === undefined || found === null ? undefined : String(found);
}

export function interpolate(
  url: string,
  values: { version: string; name: string; url: string },
): string {
  return url
    .replaceAll("${recipe.version}", values.version)
    .replaceAll("${recipe.name}", values.name)
    .replaceAll("${recipe.url}", values.url);
}

const TOP_LEVEL = new Set([
  "recipe",
  "source",
  "package",
  "prepare",
  "build",
  "install",
  "check",
]);
const RECIPE_FIELDS = new Set([
  "name",
  "version",
  "release",
  "description",
  "url",
  "licenses",
  "archs",
  "depends",
  "env",
  "needs-root",
]);
/** Fields mere rejects when repeated; the rest may repeat. */
const RECIPE_SINGLE = new Set([
  "name",
  "version",
  "release",
  "description",
  "url",
  "licenses",
  "archs",
  "needs-root",
]);
const SOURCE_FIELDS = new Set(["blake3", "save-as", "env"]);
const SOURCE_SINGLE = new Set(["blake3", "save-as"]);
const PACKAGE_FIELDS = new Set(["files", "strip", "service", "realizer"]);
const PACKAGE_SINGLE = new Set(["files", "strip", "realizer"]);
const KNOWN_ARCHS = new Set(["aarch64", "x86_64", "any"]);

/** Mirror mere's structural rules: no unknown nodes, no repeated singletons. */
function checkStructure(
  where: string,
  nodes: Node[],
  allowed: Set<string>,
  single: Set<string>,
  relPath: string,
) {
  const seen = new Set<string>();
  for (const node of nodes) {
    const name = node.getName();
    if (!allowed.has(name)) {
      throw new Error(`${relPath}: unknown ${where} field "${name}"`);
    }
    if (single.has(name)) {
      if (seen.has(name)) {
        throw new Error(`${relPath}: ${where} field "${name}" repeated`);
      }
      seen.add(name);
    }
  }
}

/** Parse a recipe.kdl (KDL v1 syntax) into structured data. Never edits it. */
export function parseRecipe(text: string, relPath: string): ParsedRecipe {
  const { text: normalizedText, normalized } = normalizeContinuations(text);
  const doc = parse(normalizedText);
  const recipes = doc.nodes.filter((n) => n.getName() === "recipe");
  if (recipes.length !== 1) {
    throw new Error(
      `${relPath}: expected exactly one recipe node, found ${recipes.length}`,
    );
  }
  const recipe = recipes[0];
  const phaseSeen = new Set<string>();
  for (const node of doc.nodes) {
    const name = node.getName();
    if (!TOP_LEVEL.has(name)) {
      throw new Error(`${relPath}: unknown top-level node "${name}"`);
    }
    if (PHASES.includes(name)) {
      if (phaseSeen.has(name)) {
        throw new Error(`${relPath}: "${name}" repeated`);
      }
      phaseSeen.add(name);
    }
  }
  checkStructure(
    "recipe",
    recipe.children?.nodes ?? [],
    RECIPE_FIELDS,
    RECIPE_SINGLE,
    relPath,
  );
  const need = (field: string) => {
    const value = first(recipe, field);
    if (value === undefined) {
      throw new Error(`${relPath}: recipe has no ${field}`);
    }
    return value;
  };
  const name = need("name");
  const version = need("version");
  const releaseRaw = recipe.children?.nodes.find((n) =>
    n.getName() === "release"
  )
    ?.getArguments()[0];
  const release = typeof releaseRaw === "number" ? releaseRaw : NaN;
  if (!Number.isInteger(release) || release < 0) {
    throw new Error(`${relPath}: release must be a non-negative integer`);
  }
  for (const field of ["licenses", "archs", "depends"]) {
    for (const node of children(recipe, field)) {
      if (node.getArguments().length === 0) {
        throw new Error(`${relPath}: recipe field "${field}" has no values`);
      }
    }
  }
  const url = first(recipe, "url") ?? "";
  if (
    typeof recipe.children?.nodes.find((n) => n.getName() === "version")
      ?.getArguments()[0] !== "string"
  ) {
    throw new Error(`${relPath}: version must be a string`);
  }
  const archs = strings(children(recipe, "archs"));
  for (const arch of archs) {
    if (!KNOWN_ARCHS.has(arch)) {
      throw new Error(`${relPath}: unknown arch "${arch}"`);
    }
  }
  const env: Record<string, string> = {};
  for (const node of children(recipe, "env")) {
    for (const [key, value] of node.getProperties()) env[key] = String(value);
  }
  const parts = relPath.split("/");
  const category = parts.length >= 3 ? parts[parts.length - 3] : "";
  const values = { version, name, url };
  const sources = doc.nodes.filter((n) => n.getName() === "source").map(
    (node): RecipeSource => {
      if (typeof node.getArguments()[0] !== "string") {
        throw new Error(`${relPath}: source needs a string url or file name`);
      }
      checkStructure(
        "source",
        node.children?.nodes ?? [],
        SOURCE_FIELDS,
        SOURCE_SINGLE,
        relPath,
      );
      const raw = String(node.getArguments()[0]);
      const blake3 = first(node, "blake3");
      const saveAs = first(node, "save-as");
      return {
        url: raw,
        resolvedUrl: interpolate(raw, values),
        isLocal: !/^[a-z][a-z0-9+.-]*:\/\//i.test(interpolate(raw, values)),
        interpolatesVersion: raw.includes("${recipe.version}"),
        ...(blake3 ? { blake3 } : {}),
        ...(saveAs ? { saveAs } : {}),
      };
    },
  );
  const packages = doc.nodes.filter((n) => n.getName() === "package").map(
    (node) => {
      if (typeof node.getArguments()[0] !== "string") {
        throw new Error(`${relPath}: package needs a name`);
      }
      checkStructure(
        "package",
        node.children?.nodes ?? [],
        PACKAGE_FIELDS,
        PACKAGE_SINGLE,
        relPath,
      );
      return {
        name: String(node.getArguments()[0]),
        hasService: children(node, "service").length > 0,
        hasRealizer: children(node, "realizer").length > 0,
      };
    },
  );
  if (packages.length === 0) {
    throw new Error(`${relPath}: recipe defines no package`);
  }
  const scripts: string[] = [];
  for (const node of doc.nodes) {
    if (PHASES.includes(node.getName())) collectStrings(node, scripts);
  }
  return {
    path: relPath,
    category,
    name,
    version,
    release,
    description: first(recipe, "description") ?? "",
    url,
    licenses: strings(children(recipe, "licenses")),
    archs,
    depends: strings(children(recipe, "depends")),
    env,
    needsRoot: children(recipe, "needs-root").length > 0,
    sources,
    packages,
    phases: PHASES.filter((p) => doc.nodes.some((n) => n.getName() === p)),
    sha256OfFile: createHash("sha256").update(text).digest("hex"),
    normalized,
    hardcodedVersion: findHardcodedVersion(scripts, version),
  };
}

export interface UpstreamOverride {
  anityaProjectId?: number;
  github?: string;
  tagPrefix?: string;
  exclude?: string[];
  patchSuffix?: string;
}

const OVERRIDE_FIELDS = new Set([
  "anitya-project-id",
  "github",
  "tag-prefix",
  "exclude",
  "patch-suffix",
]);
const OVERRIDE_SINGLE = new Set([
  "anitya-project-id",
  "github",
  "tag-prefix",
  "patch-suffix",
]);

/**
 * Parse a recipe's optional upstream.kdl. Overrides only correct a wrong
 * lookup (which project, which tags, what counts as a version); nothing here
 * can hide a newer version.
 */
export function parseUpstreamOverride(
  text: string,
  relPath: string,
): UpstreamOverride {
  const doc = parse(text);
  const nodes = doc.nodes.filter((n) => n.getName() === "upstream");
  if (nodes.length !== 1 || doc.nodes.length !== 1) {
    throw new Error(`${relPath}: expected exactly one upstream node`);
  }
  const fields = nodes[0].children?.nodes ?? [];
  checkStructure("upstream", fields, OVERRIDE_FIELDS, OVERRIDE_SINGLE, relPath);
  const arg = (name: string) =>
    fields.find((n) => n.getName() === name)?.getArguments()[0];
  const out: UpstreamOverride = {};
  const project = arg("anitya-project-id");
  if (project !== undefined) {
    if (
      typeof project !== "number" || !Number.isInteger(project) || project < 1
    ) {
      throw new Error(
        `${relPath}: anitya-project-id must be a positive integer`,
      );
    }
    out.anityaProjectId = project;
  }
  const github = arg("github");
  if (github !== undefined) {
    if (typeof github !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(github)) {
      throw new Error(`${relPath}: github must be "owner/repo"`);
    }
    out.github = github;
  }
  if (out.github && out.anityaProjectId !== undefined) {
    throw new Error(`${relPath}: set github or anitya-project-id, not both`);
  }
  const prefix = arg("tag-prefix");
  if (prefix !== undefined) {
    if (typeof prefix !== "string") {
      throw new Error(`${relPath}: tag-prefix must be a string`);
    }
    out.tagPrefix = prefix;
  }
  const suffix = arg("patch-suffix");
  if (suffix !== undefined) {
    if (typeof suffix !== "string" || !/^[A-Za-z]{1,4}$/.test(suffix)) {
      throw new Error(`${relPath}: patch-suffix must be 1-4 letters`);
    }
    out.patchSuffix = suffix;
  }
  const exclude = strings(fields.filter((n) => n.getName() === "exclude"));
  for (const pattern of exclude) {
    try {
      new RegExp(pattern);
    } catch {
      throw new Error(`${relPath}: exclude "${pattern}" is not a valid regex`);
    }
  }
  if (exclude.length > 0) out.exclude = exclude;
  return out;
}
