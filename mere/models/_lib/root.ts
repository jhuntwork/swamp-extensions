import { join } from "node:path";
import { runChecked } from "./runner.ts";

export const DEFAULT_CONFIG_URL = "https://pkgs.merelinux.org/config.kdl";
export const DEFAULT_KEY_URL = "https://pkgs.merelinux.org/mere.pub";

/** Refuse roots that would touch the host's own mere store. */
export function assertIsolatedRoot(root: string) {
  const normalized = root.replace(/\/+$/, "");
  if (
    !root.startsWith("/") || normalized === "" || normalized === "/mere" ||
    normalized.startsWith("/mere/")
  ) {
    throw new Error(
      `mere root must be an absolute path outside the host store, got "${root}"`,
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function fetchBytes(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<Uint8Array> {
  if (new URL(url).protocol !== "https:") {
    throw new Error(`URL must use HTTPS: ${url}`);
  }
  const response = await fetcher(url, { signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Download failed: HTTP ${response.status} from ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function writeAtomic(path: string, bytes: Uint8Array) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await Deno.writeFile(temporary, bytes);
  await Deno.rename(temporary, path);
}

export interface RootState {
  storePresent: boolean;
  configPresent: boolean;
  keyPresent: boolean;
}

export async function rootState(root: string): Promise<RootState> {
  return {
    storePresent: await exists(join(root, "mere", "store")),
    configPresent: await exists(join(root, "mere", "config.kdl")),
    keyPresent: await exists(join(root, "mere", "keys", "mere.pub")),
  };
}

/**
 * Initialise an isolated mere root: store, repository config and the public
 * key. Idempotent; failures to fetch config or key throw.
 */
export async function ensureRoot(options: {
  binary: string;
  root: string;
  configUrl: string;
  publicKeyUrl: string;
  signal: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<RootState> {
  assertIsolatedRoot(options.root);
  const fetcher = options.fetcher ?? fetch;
  await Deno.mkdir(options.root, { recursive: true });
  let state = await rootState(options.root);
  if (!state.storePresent) {
    await runChecked(
      options.binary,
      ["--root", options.root, "store", "init"],
      {
        signal: options.signal,
        timeoutMs: 120_000,
      },
    );
  }
  const mereDir = join(options.root, "mere");
  await Deno.mkdir(join(mereDir, "keys"), { recursive: true });
  state = await rootState(options.root);
  if (!state.configPresent) {
    await writeAtomic(
      join(mereDir, "config.kdl"),
      await fetchBytes(options.configUrl, options.signal, fetcher),
    );
  }
  if (!state.keyPresent) {
    await writeAtomic(
      join(mereDir, "keys", "mere.pub"),
      await fetchBytes(options.publicKeyUrl, options.signal, fetcher),
    );
  }
  return await rootState(options.root);
}
