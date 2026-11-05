import { assertEquals } from "../models/_lib/assert_test.ts";
import { parseRecipe } from "../models/_lib/kdl.ts";
import { runCommand } from "../models/_lib/runner.ts";
import { sha256File } from "../toolchain.ts";
import { KNOWN_DIVERGENCES, mutations } from "./conformance_cases.ts";
import { NETWORK } from "./harness.ts";
import { join } from "node:path";

const MERE_VERSION = "0.23.0";
const FIXTURE = new URL(
  "../testdata/merelinux/recipes/core/zlib-ng/recipe.kdl",
  import.meta.url,
).pathname;

interface Inputs {
  mere: string;
  root: string;
  tree: string;
  cleanup: () => Promise<void>;
}

async function download(url: string, to: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  await Deno.writeFile(to, new Uint8Array(await response.arrayBuffer()), {
    mode: 0o755,
  });
}

/** MERE_BIN and MERE_RECIPES_DIR if set, else fetch both (network). */
async function inputs(): Promise<Inputs | undefined> {
  const scratch = await Deno.makeTempDir({ prefix: "mere-conf-" });
  let mere = Deno.env.get("MERE_BIN") ?? "";
  let tree = Deno.env.get("MERE_RECIPES_DIR") ?? "";
  if (!mere || !tree) {
    if (!NETWORK) return undefined;
    if (!mere) {
      const arch = Deno.build.arch;
      const name = `mere-${MERE_VERSION}-linux-${arch}`;
      const base =
        `https://github.com/jhuntwork/mere/releases/download/v${MERE_VERSION}`;
      mere = join(scratch, name);
      await download(`${base}/${name}`, mere);
      const sums = await (await fetch(`${base}/SHA256SUMS`)).text();
      const expected = sums.split("\n").find((l) => l.endsWith(name))?.split(
        /\s+/,
      )[0];
      assertEquals(await sha256File(mere), expected);
    }
    if (!tree) {
      tree = join(scratch, "merelinux");
      const clone = await runCommand("git", [
        "clone",
        "--depth",
        "1",
        "https://github.com/jhuntwork/merelinux.git",
        tree,
      ]);
      assertEquals(clone.exitCode, 0, clone.stderr);
    }
  }
  const root = join(scratch, "root");
  await Deno.mkdir(root);
  const init = await runCommand(mere, ["--root", root, "store", "init"]);
  assertEquals(init.exitCode, 0, init.stderr);
  return {
    mere,
    root,
    tree,
    cleanup: () => Deno.remove(scratch, { recursive: true }),
  };
}

async function mereAccepts(
  io: Inputs,
  file: string,
): Promise<{ ok: boolean; detail: string }> {
  const result = await runCommand(io.mere, [
    "--root",
    io.root,
    "dev",
    "validate",
    file,
  ]);
  return {
    ok: result.exitCode === 0,
    detail: (result.stderr || result.stdout).trim().split("\n")[0],
  };
}

function weAccept(text: string): { ok: boolean; detail: string } {
  try {
    parseRecipe(text, "recipes/core/example/recipe.kdl");
    return { ok: true, detail: "" };
  } catch (error) {
    return {
      ok: false,
      detail: String(error instanceof Error ? error.message : error),
    };
  }
}

async function pool<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}

Deno.test({
  name:
    "our recipe parser agrees with `mere dev validate` on every real recipe",
  ignore: !Deno.env.get("MERE_BIN") && !NETWORK,
  fn: async () => {
    const io = (await inputs())!;
    try {
      const files: string[] = [];
      for await (const category of Deno.readDir(join(io.tree, "recipes"))) {
        if (!category.isDirectory) continue;
        for await (
          const entry of Deno.readDir(join(io.tree, "recipes", category.name))
        ) {
          const file = join(
            io.tree,
            "recipes",
            category.name,
            entry.name,
            "recipe.kdl",
          );
          try {
            await Deno.stat(file);
            files.push(file);
          } catch { /* not a recipe directory */ }
        }
      }
      assertEquals(files.length > 100, true);
      const disagreements = (await pool(files, 8, async (file) => {
        const mere = await mereAccepts(io, file);
        const ours = weAccept(await Deno.readTextFile(file));
        return mere.ok === ours.ok
          ? undefined
          : `${file}: mere=${mere.ok ? "ok" : mere.detail} ours=${
            ours.ok ? "ok" : ours.detail
          }`;
      })).filter(Boolean);
      assertEquals(disagreements, []);
    } finally {
      await io.cleanup();
    }
  },
});

Deno.test({
  name: "our recipe parser agrees with `mere dev validate` on mutated recipes",
  ignore: !Deno.env.get("MERE_BIN") && !NETWORK,
  fn: async () => {
    const io = (await inputs())!;
    try {
      const cases = Object.entries(mutations(await Deno.readTextFile(FIXTURE)));
      const scratch = await Deno.makeTempDir();
      try {
        const rows = await pool(cases, 8, async ([name, text]) => {
          const dir = join(scratch, name);
          await Deno.mkdir(dir);
          const file = join(dir, "recipe.kdl");
          await Deno.writeTextFile(file, text);
          const mere = await mereAccepts(io, file);
          const ours = weAccept(text);
          return { name, mere, ours };
        });
        const unexpected = rows.filter((r) =>
          r.mere.ok !== r.ours.ok && !(r.name in KNOWN_DIVERGENCES)
        ).map((r) =>
          `${r.name}: mere=${
            r.mere.ok ? "ok" : "reject (" + r.mere.detail.slice(0, 80) + ")"
          } ours=${
            r.ours.ok ? "ok" : "reject (" + r.ours.detail.slice(0, 80) + ")"
          }`
        );
        assertEquals(unexpected, []);
        // The suite must exercise both outcomes, or it proves nothing.
        assertEquals(rows.some((r) => r.mere.ok), true);
        assertEquals(rows.some((r) => !r.mere.ok), true);
        assertEquals(rows.find((r) => r.name === "valid")!.mere.ok, true);
      } finally {
        await Deno.remove(scratch, { recursive: true });
      }
    } finally {
      await io.cleanup();
    }
  },
});
