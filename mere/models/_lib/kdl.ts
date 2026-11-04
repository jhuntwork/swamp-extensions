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
}

type Node = ReturnType<typeof parse>["nodes"][number];

const PHASES = ["prepare", "build", "install", "check"];

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

/** Parse a recipe.kdl (KDL v1 syntax) into structured data. Never edits it. */
export function parseRecipe(text: string, relPath: string): ParsedRecipe {
  const { text: normalizedText, normalized } = normalizeContinuations(text);
  const doc = parse(normalizedText);
  const recipe = doc.nodes.find((n) => n.getName() === "recipe");
  if (!recipe) throw new Error(`${relPath}: no recipe node`);
  const need = (field: string) => {
    const value = first(recipe, field);
    if (value === undefined) {
      throw new Error(`${relPath}: recipe has no ${field}`);
    }
    return value;
  };
  const name = need("name");
  const version = need("version");
  const release = Number(need("release"));
  if (!Number.isInteger(release) || release < 0) {
    throw new Error(`${relPath}: release must be a non-negative integer`);
  }
  const url = need("url");
  const env: Record<string, string> = {};
  for (const node of children(recipe, "env")) {
    for (const [key, value] of node.getProperties()) env[key] = String(value);
  }
  const parts = relPath.split("/");
  const category = parts.length >= 3 ? parts[parts.length - 3] : "";
  const values = { version, name, url };
  const sources = doc.nodes.filter((n) => n.getName() === "source").map(
    (node): RecipeSource => {
      const raw = String(node.getArguments()[0] ?? "");
      const blake3 = first(node, "blake3");
      const saveAs = first(node, "save-as");
      return {
        url: raw,
        resolvedUrl: interpolate(raw, values),
        isLocal: !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw),
        interpolatesVersion: raw.includes("${recipe.version}"),
        ...(blake3 ? { blake3 } : {}),
        ...(saveAs ? { saveAs } : {}),
      };
    },
  );
  const packages = doc.nodes.filter((n) => n.getName() === "package").map(
    (node) => ({
      name: String(node.getArguments()[0] ?? ""),
      hasService: children(node, "service").length > 0,
      hasRealizer: children(node, "realizer").length > 0,
    }),
  );
  return {
    path: relPath,
    category,
    name,
    version,
    release,
    description: first(recipe, "description") ?? "",
    url,
    licenses: strings(children(recipe, "licenses")),
    archs: strings(children(recipe, "archs")),
    depends: strings(children(recipe, "depends")),
    env,
    needsRoot: children(recipe, "needs-root").length > 0,
    sources,
    packages,
    phases: PHASES.filter((p) => doc.nodes.some((n) => n.getName() === p)),
    sha256OfFile: createHash("sha256").update(text).digest("hex"),
    normalized,
  };
}
