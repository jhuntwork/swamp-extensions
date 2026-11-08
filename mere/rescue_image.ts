// ABOUTME: Build and validate the pinned Mere rescue image from an immutable Merelinux checkout.
// ABOUTME: The behavior owns fixed-argv assembly and provenance checks; workflows own checkout and orchestration.
// deno-lint-ignore-file no-import-prefix
import { dirname, relative, resolve, sep } from "node:path";
import { z } from "npm:zod@4";
import { runChecked, runCommand } from "./models/_lib/runner.ts";

const SOURCE_COMMIT = /^[0-9a-f]{40}$/;
const REQUIRED_REPOSITORY = "github.com/jhuntwork/merelinux";
const MAX_OUTPUT_BYTES = 128 * 1024;
const BUILD_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const UNSAFE_COMMANDS = new Set([
  "swapon",
  "swapoff",
  "fsck",
  "e2fsck",
  "xfs_repair",
  "btrfs",
  "partprobe",
  "kpartx",
]);

type ModelContext = {
  repoDir: string;
  signal?: AbortSignal;
  writeResource: (
    name: ResourceName,
    key: string,
    attributes: Record<string, unknown>,
  ) => Promise<unknown>;
};

type ResourceName =
  | "rescue-build"
  | "rescue-manifest"
  | "rescue-safety";

type Manifest = {
  format?: number;
  architecture?: string;
  source_revision?: string;
  image_builder_revision?: string;
  environment?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  tool_profile?: Record<string, unknown>;
  image_tool_versions?: Record<string, string>;
  commands?: string[][];
  artifacts?: {
    rescue?: { first?: Artifact; second?: Artifact; byte_identical?: boolean };
    fixture?: {
      first?: Artifact;
      second?: Artifact;
      byte_identical?: boolean;
      dirty_journal?: Artifact;
    };
  };
  reproducibility?: {
    clean_builds_compared?: boolean;
    rescue_byte_identical?: boolean;
    fixture_byte_identical?: boolean;
  };
  no_initramfs?: boolean;
  [key: string]: unknown;
};

type Artifact = {
  path?: string;
  blake3?: string;
  [key: string]: unknown;
};

const RescueImageArgsSchema = z.object({
  sourcePath: z.string().min(1).refine(
    (value) => value.startsWith("/"),
    "sourcePath must be an absolute path",
  ),
  outputDir: z.string().min(1).refine(
    (value) => value.startsWith("/"),
    "outputDir must be an absolute path",
  ),
  workspaceRoot: z.string().min(1).refine(
    (value) => value.startsWith("/"),
    "workspaceRoot must be an absolute path",
  ),
  sourceCommit: z.string().regex(
    SOURCE_COMMIT,
    "sourceCommit must be a lowercase 40-character Git commit",
  ),
  repositoryUrl: z.string().url().default(
    "https://github.com/jhuntwork/merelinux.git",
  ),
  workerLabel: z.string().min(1),
  environmentProfile: z.string().min(1),
  swampRepoDir: z.string().min(1).refine(
    (value) => value.startsWith("/"),
    "swampRepoDir must be an absolute path",
  ),
  swampServerTokenFile: z.string().default(""),
  mereDevBehavior: z.string().min(1),
  mereVersion: z.string().min(1),
  linuxPackage: z.string().min(1).refine(
    (value) => value.startsWith("/"),
    "linuxPackage must be an absolute path",
  ),
  mereDevRoot: z.string().min(1).refine(
    (value) => value.startsWith("/"),
    "mereDevRoot must be an absolute path",
  ),
  mereBinary: z.string().min(1).refine(
    (value) => value.startsWith("/"),
    "mereBinary must be an absolute path",
  ),
  toolProfileRoot: z.string().min(1).refine(
    (value) => value.startsWith("/"),
    "toolProfileRoot must be an absolute path",
  ),
  ovmfToolProfileRoot: z.string().min(1).refine(
    (value) => value.startsWith("/"),
    "ovmfToolProfileRoot must be an absolute path",
  ),
  safetySentinelPath: z.string().min(1).refine(
    (value) => value.startsWith("/"),
    "safetySentinelPath must be an absolute path",
  ),
  includeFixture: z.boolean().default(false),
  fullCompare: z.boolean().default(false),
});

type RescueImageArgs = z.infer<typeof RescueImageArgsSchema>;

const ArtifactSchema = z.object({
  path: z.string(),
  blake3: z.string().regex(/^[0-9a-f]{64}$/),
});
const ArtifactPairSchema = z.object({
  first: ArtifactSchema,
  second: ArtifactSchema.optional(),
  byte_identical: z.boolean().optional(),
});
const ManifestSchema = z.object({
  format: z.number(),
  architecture: z.string(),
  source_revision: z.string(),
  image_builder_revision: z.string(),
  artifacts: z.object({
    rescue: ArtifactPairSchema,
    fixture: ArtifactPairSchema.optional(),
  }),
  reproducibility: z.object({
    clean_builds_compared: z.boolean(),
    rescue_byte_identical: z.boolean(),
    fixture_byte_identical: z.boolean(),
  }),
  no_initramfs: z.boolean(),
}).passthrough();

const BuildSchema = z.object({
  attempt: z.string(),
  sourceCommit: z.string(),
  mereVersion: z.string(),
  repositoryUrl: z.string(),
  verifiedRemote: z.string(),
  architecture: z.literal("x86_64"),
  virtualization: z.literal("qemu-kvm"),
  workerLabel: z.string(),
  environmentProfile: z.string(),
  outputDir: z.string(),
  manifestPath: z.string(),
  rescueDigest: z.string(),
  fixtureDigest: z.string(),
  dirtyFixtureDigest: z.string(),
  manifestSha256: z.string(),
  sourceTreeClean: z.boolean(),
  detached: z.literal(true),
});

const ManifestResourceSchema = z.object({
  manifestPath: z.string(),
  sourceCommit: z.string(),
  repositoryUrl: z.string(),
  verifiedRemote: z.string(),
  manifest: z.record(z.string(), z.unknown()),
});

const SafetySchema = z.object({
  sentinelPath: z.string(),
  sentinelSha256Before: z.string(),
  sentinelSha256After: z.string(),
  sentinelUnchanged: z.boolean(),
  unsafeCommands: z.array(z.array(z.string())),
  loopMountsOnly: z.boolean(),
  accepted: z.boolean(),
});

function isWithinRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) &&
    !path.startsWith(sep);
}

/** Keep source, outputs, and sentinels inside the per-repository Swamp workspace. */
export function isWithinWorkspace(root: string, candidate: string): boolean {
  return isWithinRoot(resolve(root), resolve(candidate));
}

/** Normalize GitHub HTTPS, SSH, and scp-style remote spellings to one identity. */
export function normalizeRepository(value: string): string {
  let remote = value.trim();
  if (remote.startsWith("git@") && remote.includes(":")) {
    remote = `ssh://${remote.slice(4).replace(":", "/")}`;
  }
  if (!remote.includes("://")) remote = `https://${remote}`;
  const parsed = new URL(remote);
  return `${parsed.hostname.toLowerCase()}${
    parsed.pathname.replace(/\.git$/, "").replace(/\/$/, "")
  }`;
}

/** Reject an assembler command that could activate or repair an attached disk. */
export function unsafeDiskCommands(commands: string[][]): string[][] {
  return commands.filter((argv) =>
    argv.some((part) => UNSAFE_COMMANDS.has(part.split("/").pop() ?? ""))
  );
}

/** Mounts are accepted only when the assembler explicitly uses a loop image. */
export function onlyLoopMounts(commands: string[][]): boolean {
  return commands.every((argv) => {
    const command = argv[0]?.split("/").pop();
    if (command !== "mount") return true;
    if (argv.includes("--version") || argv.includes("--help")) return true;
    const option = argv.find((part) => part.includes("loop"));
    return option !== undefined;
  });
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

async function requireExistingFile(
  path: string,
  label: string,
): Promise<void> {
  const stat = await Deno.stat(path);
  if (!stat.isFile) throw new Error(`${label} must be a file: ${path}`);
}

async function requireExistingDirectory(
  path: string,
  label: string,
): Promise<void> {
  const stat = await Deno.stat(path);
  if (!stat.isDirectory) {
    throw new Error(`${label} must be a directory: ${path}`);
  }
}

async function requireCharacterDevice(
  path: string,
  label: string,
): Promise<void> {
  // Deno compiled binaries cannot stat device nodes with their intentionally
  // narrow --allow-read permission set. Use the already-permitted subprocess
  // path for this metadata-only check; QEMU performs the actual KVM open.
  const result = await runCommand("test", ["-c", path], {
    timeoutMs: 10_000,
    maxOutputBytes: 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error(`${label} must be a character device: ${path}`);
  }
}

async function requireWorkspacePath(
  path: string,
  root: string,
  label: string,
  mustExist: boolean,
): Promise<string> {
  const candidate = resolve(path);
  if (!isWithinWorkspace(root, candidate)) {
    throw new Error(`${label} must be inside ${root}: ${path}`);
  }
  if (mustExist) {
    await Deno.realPath(candidate);
  } else if (await exists(candidate)) {
    throw new Error(
      `${label} must start absent for an isolated attempt: ${path}`,
    );
  } else {
    await requireExistingDirectory(dirname(candidate), `${label} parent`);
  }
  return candidate;
}

async function sha256(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function gitOutput(
  args: string[],
  cwd?: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runChecked("git", args, {
    cwd,
    signal,
    timeoutMs: 60_000,
    maxOutputBytes: 16 * 1024,
  });
  return result.stdout.trim();
}

async function verifyCheckout(
  args: RescueImageArgs,
  signal?: AbortSignal,
): Promise<{
  remote: string;
  head: string;
  clean: boolean;
  detached: true;
}> {
  await requireExistingDirectory(args.sourcePath, "sourcePath");
  await requireExistingFile(
    `${args.sourcePath}/misc-util/rescue-image-build`,
    "rescue assembler",
  );
  await requireExistingFile(
    `${args.sourcePath}/misc-util/rescue-image.inputs.json`,
    "rescue inputs",
  );
  const remote = await gitOutput(
    ["-C", args.sourcePath, "remote", "get-url", "origin"],
    undefined,
    signal,
  );
  if (normalizeRepository(remote) !== REQUIRED_REPOSITORY) {
    throw new Error(`unexpected Merelinux remote: ${remote}`);
  }
  if (normalizeRepository(args.repositoryUrl) !== REQUIRED_REPOSITORY) {
    throw new Error(`repositoryUrl must identify ${REQUIRED_REPOSITORY}`);
  }
  const head = await gitOutput(
    ["-C", args.sourcePath, "rev-parse", "--verify", "HEAD"],
    undefined,
    signal,
  );
  if (head !== args.sourceCommit) {
    throw new Error(
      `checkout HEAD ${head} does not match sourceCommit ${args.sourceCommit}`,
    );
  }
  await gitOutput(
    ["-C", args.sourcePath, "cat-file", "-e", `${args.sourceCommit}^{commit}`],
    undefined,
    signal,
  );
  const symbolicHead = await runCommand("git", [
    "-C",
    args.sourcePath,
    "symbolic-ref",
    "--quiet",
    "HEAD",
  ], {
    signal,
    timeoutMs: 60_000,
    maxOutputBytes: 16 * 1024,
  });
  if (symbolicHead.exitCode === 0) {
    throw new Error("source checkout must be detached at sourceCommit");
  }
  if (symbolicHead.exitCode !== 1) {
    throw new Error("could not verify detached source checkout");
  }
  const status = await runChecked("git", [
    "-C",
    args.sourcePath,
    "status",
    "--porcelain=v1",
  ], {
    signal,
    timeoutMs: 60_000,
    maxOutputBytes: 16 * 1024,
  });
  return { remote, head, clean: status.stdout.trim() === "", detached: true };
}

function artifact(manifest: Manifest, kind: "rescue" | "fixture"): Artifact {
  const value = manifest.artifacts?.[kind]?.first;
  if (!value?.path || !value.blake3) {
    throw new Error(`manifest has no ${kind} artifact`);
  }
  return value;
}

function compareArtifactPaths(
  manifest: Manifest,
  outputDir: string,
): void {
  const artifacts: (Artifact | undefined)[] = [artifact(manifest, "rescue")];
  const fixture = manifest.artifacts?.fixture;
  if (fixture?.first) artifacts.push(fixture.first);
  if (fixture?.dirty_journal) artifacts.push(fixture.dirty_journal);
  for (const value of artifacts) {
    if (!value?.path || !isWithinWorkspace(outputDir, value.path)) {
      throw new Error(
        `manifest artifact escapes output directory: ${
          value?.path ?? "missing"
        }`,
      );
    }
  }
}

function validateManifest(
  value: unknown,
  sourceCommit: string,
  outputDir: string,
  options: { includeFixture: boolean; fullCompare: boolean },
): Manifest {
  const manifest = ManifestSchema.parse(value) as Manifest;
  if (manifest.architecture !== "x86_64") {
    throw new Error("manifest architecture is not x86_64");
  }
  if (manifest.source_revision !== sourceCommit) {
    throw new Error(
      `manifest source_revision ${manifest.source_revision} does not match ${sourceCommit}`,
    );
  }
  if (options.includeFixture && !manifest.artifacts?.fixture?.first) {
    throw new Error("assembler did not produce the requested fixture artifact");
  }
  if (options.fullCompare) {
    if (
      !manifest.artifacts?.rescue?.second ||
      !manifest.artifacts.rescue.byte_identical ||
      !manifest.artifacts.fixture?.second ||
      !manifest.artifacts.fixture.byte_identical ||
      !manifest.artifacts.fixture.dirty_journal
    ) {
      throw new Error(
        "assembler did not prove byte-identical internal clean builds",
      );
    }
    if (
      !manifest.reproducibility?.clean_builds_compared ||
      !manifest.reproducibility.rescue_byte_identical ||
      !manifest.reproducibility.fixture_byte_identical
    ) {
      throw new Error("manifest reproducibility comparison failed");
    }
  }
  if (!manifest.no_initramfs) {
    throw new Error("image invariant failed: initramfs is present");
  }
  compareArtifactPaths(manifest, outputDir);
  return manifest;
}

function commandSafety(manifest: Manifest): {
  unsafe: string[][];
  loopMountsOnly: boolean;
} {
  const commands = manifest.commands ?? [];
  return {
    unsafe: unsafeDiskCommands(commands),
    loopMountsOnly: onlyLoopMounts(commands),
  };
}

type GuestArchiveEntry = {
  path: string;
  mode: number;
  source?: string;
  data?: Uint8Array;
  symlink?: string;
};

type GuestShare = {
  tag: string;
  hostPath: string;
  guestPath: string;
  readonly: boolean;
};

const CPIO_MAGIC = "070701";
const CPIO_TRAILER = "TRAILER!!!";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function cpioField(value: number): string {
  return value.toString(16).padStart(8, "0");
}

function archivePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized.startsWith("/")) {
    throw new Error(`initramfs path must be absolute: ${value}`);
  }
  return normalized.slice(1) || ".";
}

function addArchiveDirectory(
  entries: Map<string, GuestArchiveEntry>,
  value: string,
): void {
  const normalized = archivePath(value);
  if (normalized === ".") return;
  const parts = normalized.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!entries.has(current)) {
      entries.set(current, { path: current, mode: 0o040755 });
    }
  }
}

function addArchiveSymlink(
  entries: Map<string, GuestArchiveEntry>,
  value: string,
  target: string,
): void {
  const normalized = archivePath(value);
  addArchiveDirectory(entries, dirname(`/${normalized}`));
  entries.set(normalized, {
    path: normalized,
    mode: 0o120777,
    symlink: target,
  });
}

async function addArchiveFile(
  entries: Map<string, GuestArchiveEntry>,
  source: string,
  target: string,
): Promise<void> {
  const normalized = archivePath(target);
  const info = await Deno.lstat(source);
  addArchiveDirectory(entries, dirname(`/${normalized}`));
  if (info.isSymlink) {
    entries.set(normalized, {
      path: normalized,
      mode: 0o120777,
      symlink: await Deno.readLink(source),
    });
    return;
  }
  if (!info.isFile) {
    throw new Error(`initramfs source must be a file or symlink: ${source}`);
  }
  entries.set(normalized, {
    path: normalized,
    mode: 0o100000 | ((info.mode ?? 0o755) & 0o7777),
    source,
  });
}

async function writeAll(file: Deno.FsFile, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const written = await file.write(data.subarray(offset));
    if (written === null) throw new Error("unexpected EOF writing initramfs");
    offset += written;
  }
}

async function writeCpioArchive(
  entries: Map<string, GuestArchiveEntry>,
  destination: string,
): Promise<void> {
  const output = await Deno.open(destination, {
    create: true,
    truncate: true,
    write: true,
  });
  const encoder = new TextEncoder();
  let inode = 1;
  const pad = async (length: number): Promise<void> => {
    const padding = (4 - (length % 4)) % 4;
    if (padding > 0) await writeAll(output, new Uint8Array(padding));
  };
  try {
    for (
      const entry of [...entries.values()].sort((a, b) =>
        a.path.localeCompare(b.path)
      )
    ) {
      const name = `${entry.path}\0`;
      const nameBytes = encoder.encode(name);
      const linkBytes = entry.symlink === undefined
        ? undefined
        : encoder.encode(entry.symlink);
      let size = linkBytes?.length ?? entry.data?.length ?? 0;
      if (entry.source) size = (await Deno.stat(entry.source)).size;
      const header = [
        CPIO_MAGIC,
        cpioField(inode++),
        cpioField(entry.mode),
        cpioField(0),
        cpioField(0),
        cpioField(1),
        cpioField(0),
        cpioField(size),
        cpioField(0),
        cpioField(0),
        cpioField(0),
        cpioField(0),
        cpioField(nameBytes.length),
        cpioField(0),
      ].join("");
      await writeAll(output, encoder.encode(header));
      await writeAll(output, nameBytes);
      await pad(110 + nameBytes.length);
      if (linkBytes) {
        await writeAll(output, linkBytes);
        await pad(linkBytes.length);
      } else if (entry.data) {
        await writeAll(output, entry.data);
        await pad(entry.data.length);
      } else if (entry.source) {
        const input = await Deno.open(entry.source, { read: true });
        const buffer = new Uint8Array(1024 * 1024);
        try {
          while (true) {
            const read = await input.read(buffer);
            if (read === null) break;
            await writeAll(output, buffer.subarray(0, read));
          }
        } finally {
          input.close();
        }
        await pad(size);
      }
    }
    const trailerName = `${CPIO_TRAILER}\0`;
    const trailerBytes = encoder.encode(trailerName);
    const trailer = [
      CPIO_MAGIC,
      cpioField(inode++),
      cpioField(0),
      cpioField(0),
      cpioField(0),
      cpioField(1),
      cpioField(0),
      cpioField(0),
      cpioField(0),
      cpioField(0),
      cpioField(0),
      cpioField(0),
      cpioField(trailerBytes.length),
      cpioField(0),
    ].join("");
    await writeAll(output, encoder.encode(trailer));
    await writeAll(output, trailerBytes);
    await pad(110 + trailerBytes.length);
  } finally {
    output.close();
  }
}

async function executableOnHost(
  name: string,
  candidates: string[] = [],
): Promise<string> {
  const pathCandidates = [...candidates];
  const path = Deno.env.get("PATH") ?? "";
  pathCandidates.push(
    ...path.split(":").filter(Boolean).map((directory) =>
      `${directory}/${name}`
    ),
  );
  for (const candidate of pathCandidates) {
    try {
      const info = await Deno.stat(candidate);
      if (
        info.isFile && (info.mode === null || (info.mode & 0o111) !== 0)
      ) {
        return candidate;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  throw new Error(
    `required executable is unavailable on the QEMU worker: ${name}`,
  );
}

async function selectGuestKernel(): Promise<string> {
  const candidates: string[] = [];
  for (
    const candidate of [
      "/boot/vmlinux-6.18.62-97b4fffa8ba29d6d",
      "/boot/vmlinux-6.18.42-b048dabd3eda59da",
      "/boot/vmlinux-6.18.42-efbae16e5f2fb6ef",
      "/boot/vmlinux",
    ]
  ) {
    try {
      const info = await Deno.stat(candidate);
      if (info.isFile) candidates.push(candidate);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  if (candidates.length === 0) {
    for await (const entry of Deno.readDir("/boot")) {
      if (entry.isFile && entry.name.startsWith("vmlinux-")) {
        candidates.push(`/boot/${entry.name}`);
      }
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      "QEMU worker has no usable x86_64 vmlinux kernel under /boot",
    );
  }
  return candidates[0];
}

function uniqueShares(shares: GuestShare[]): GuestShare[] {
  const seen = new Set<string>();
  return shares.filter((share) => {
    const key = `${share.hostPath}\\0${share.guestPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.guestPath.length - b.guestPath.length);
}

async function buildGuestInitramfs(
  commandArgs: string[],
  shares: GuestShare[],
  statusPath: string,
  outputPath: string,
  mereBinary: string,
): Promise<string> {
  const temporary = await Deno.makeTempDir({ prefix: "mere-rescue-qemu-" });
  const archive = `${temporary}/initramfs.cpio`;
  const entries = new Map<string, GuestArchiveEntry>();
  for (
    const directory of [
      "/bin",
      "/dev",
      "/etc",
      "/home",
      "/lib",
      "/lib64",
      "/mere",
      "/mnt",
      "/proc",
      "/root",
      "/sbin",
      "/sys",
      "/tmp",
      "/usr",
      "/usr/lib",
      "/usr/share",
    ]
  ) addArchiveDirectory(entries, directory);

  const busybox = await Deno.realPath("/bin/busybox");
  const python = "/usr/bin/python3";
  const pythonTarget = await Deno.readLink(python);
  const pythonHome = pythonTarget.endsWith("/usr/bin/python3")
    ? `${pythonTarget.slice(0, -"/usr/bin/python3".length)}/usr`
    : "";
  const git = "/usr/bin/git";
  const musl = "/lib/ld-musl-x86_64.so.1";
  const mimalloc = "/usr/lib/libmimalloc.so.3";
  const zlib = "/usr/lib/libz.so.1";
  await addArchiveFile(entries, busybox, "/bin/busybox");
  await addArchiveFile(entries, python, "/bin/python3");
  await addArchiveFile(entries, git, "/bin/git");
  await addArchiveFile(entries, musl, musl);
  await addArchiveFile(entries, mimalloc, mimalloc);
  await addArchiveFile(entries, zlib, zlib);
  await addArchiveFile(entries, mereBinary, "/bin/mere");
  for (
    const applet of [
      "cat",
      "cp",
      "dd",
      "grep",
      "head",
      "losetup",
      "mount",
      "mkdir",
      "readlink",
      "rm",
      "setpriv",
      "sh",
      "sleep",
      "sync",
      "umount",
      "uname",
    ]
  ) addArchiveSymlink(entries, `/bin/${applet}`, "busybox");
  const guestOutput = shellQuote(outputPath);
  const guestCommand = ["python3", ...commandArgs].map(shellQuote).join(" ");
  const shareCommands = uniqueShares(shares).map((share) => {
    const options = `trans=virtio,version=9p2000.L,msize=512000,cache=loose${
      share.readonly ? ",ro" : ""
    }`;
    return `mkdir -p ${
      shellQuote(share.guestPath)
    } && mount -t 9p -o ${options} ${shellQuote(share.tag)} ${
      shellQuote(share.guestPath)
    } || { write_status 125; exit 0; }`;
  }).join("\n");
  const init = `#!/bin/sh
PATH=/bin:/sbin:/usr/bin:/usr/sbin
status_path=${shellQuote(statusPath)}
write_status() { printf '%s\\n' "$1" > "$status_path"; sync; }
mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
mount -t proc proc /proc 2>/dev/null || true
mount -t sysfs sysfs /sys 2>/dev/null || true
${shareCommands}
if [ ! -b /dev/vda ]; then write_status 125; exit 0; fi
mkdir -p /mnt/scratch
if ! mount -t ext4 /dev/vda /mnt/scratch; then write_status 125; exit 0; fi
mkdir -p /mnt/scratch/generated-inputs
cp -a ${guestOutput}/generated-inputs/rescue-root /mnt/scratch/generated-inputs/ || { write_status 125; exit 0; }
cp -a ${guestOutput}/generated-inputs/package-manifest.json /mnt/scratch/generated-inputs/ || { write_status 125; exit 0; }
cp -a ${guestOutput}/generated-inputs/firmware-manifest.json /mnt/scratch/generated-inputs/ || { write_status 125; exit 0; }
cp -a ${guestOutput}/generated-inputs/limine.efi /mnt/scratch/generated-inputs/ || { write_status 125; exit 0; }
if [ -e ${guestOutput}/generated-inputs/fixture-root ]; then
  cp -a ${guestOutput}/generated-inputs/fixture-root /mnt/scratch/generated-inputs/ || { write_status 125; exit 0; }
  cp -a ${guestOutput}/generated-inputs/fixture-esp /mnt/scratch/generated-inputs/ || { write_status 125; exit 0; }
fi
umount -l /mnt/scratch || { write_status 125; exit 0; }
if ! mount -t ext4 /dev/vda ${guestOutput}; then write_status 125; exit 0; fi

export HOME=/root
export LC_ALL=C
export TZ=UTC
${pythonHome ? `export PYTHONHOME=${shellQuote(pythonHome)}` : ""}
mkdir -p /root
${guestCommand}
rc=$?
sync
umount -l ${guestOutput} 2>/dev/null || true
write_status "$rc"
sleep 2
exit 0
`;
  entries.set("init", {
    path: "init",
    mode: 0o100755,
    data: new TextEncoder().encode(init),
  });
  await writeCpioArchive(entries, archive);
  await runChecked("gzip", ["-9", archive]);
  return `${archive}.gz`;
}

const GUEST_SCRATCH_BYTES = 8 * 1024 * 1024 * 1024;

async function formatScratchDisk(
  path: string,
  args: RescueImageArgs,
  signal?: AbortSignal,
): Promise<void> {
  const mkfs = await executableOnHost("mkfs.ext4", [
    `${args.toolProfileRoot}/sbin/mkfs.ext4`,
    "/sbin/mkfs.ext4",
    "/usr/sbin/mkfs.ext4",
  ]);
  await runChecked(mkfs, ["-q", "-F", path], {
    signal,
    timeoutMs: 120_000,
    maxOutputBytes: 16 * 1024,
  });
}

async function exportScratchOutput(
  scratch: string,
  outputDir: string,
  signal?: AbortSignal,
): Promise<void> {
  const mount = await executableOnHost("mount", [
    "/bin/mount",
    "/usr/bin/mount",
  ]);
  const umount = await executableOnHost("umount", [
    "/bin/umount",
    "/usr/bin/umount",
  ]);
  const copy = await executableOnHost("cp", ["/bin/cp", "/usr/bin/cp"]);
  const mountpoint = await Deno.makeTempDir({ prefix: "mere-rescue-scratch-" });
  let mounted = false;
  try {
    await runChecked(mount, ["-o", "loop", scratch, mountpoint], {
      signal,
      timeoutMs: 120_000,
      maxOutputBytes: 16 * 1024,
    });
    mounted = true;
    await runChecked(copy, ["-a", `${mountpoint}/.`, `${outputDir}/`], {
      signal,
      timeoutMs: BUILD_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
  } finally {
    if (mounted) {
      await runChecked(umount, ["-l", mountpoint], {
        signal,
        timeoutMs: 120_000,
        maxOutputBytes: 16 * 1024,
      });
    }
    await Deno.remove(mountpoint, { recursive: true }).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
}

async function runQemuBuild(
  args: RescueImageArgs,
  commandArgs: string[],
  workspaceRoot: string,
  mereDevRoot: string,
  context: ModelContext,
): Promise<void> {
  const qemu = await executableOnHost("qemu-system-x86_64", [
    "/usr/bin/qemu-system-x86_64",
  ]);
  const kernel = await selectGuestKernel();
  const shares: GuestShare[] = [
    { tag: "mere", hostPath: "/mere", guestPath: "/mere", readonly: true },
    {
      tag: "workspace",
      hostPath: workspaceRoot,
      guestPath: workspaceRoot,
      readonly: false,
    },
    {
      tag: "mere-root",
      hostPath: mereDevRoot,
      guestPath: mereDevRoot,
      readonly: true,
    },
  ];
  for (const share of shares) {
    if (share.hostPath.includes(",") || share.guestPath.includes(",")) {
      throw new Error("QEMU shared paths cannot contain commas");
    }
  }
  const statusPath = `${args.outputDir}.qemu-status`;
  const temporary = await Deno.makeTempDir({ prefix: "mere-rescue-qemu-run-" });
  const scratch = `${temporary}/worker.raw`;
  let initramfs: string | undefined;
  try {
    await Deno.writeFile(scratch, new Uint8Array());
    await Deno.truncate(scratch, GUEST_SCRATCH_BYTES);
    await formatScratchDisk(scratch, args, context.signal);
    initramfs = await buildGuestInitramfs(
      commandArgs,
      shares,
      statusPath,
      args.outputDir,
      args.mereBinary,
    );
    const qemuArgs = [
      "-name",
      "mere-rescue-kvm-worker",
      "-accel",
      "kvm",
      "-cpu",
      "host",
      "-machine",
      "pc",
      "-m",
      "2048M",
      "-smp",
      "2",
      "-nodefaults",
      "-kernel",
      kernel,
      "-initrd",
      initramfs,
      "-append",
      "console=ttyS0,115200 rdinit=/init panic=-1",
      "-drive",
      `file=${scratch},format=raw,if=virtio,cache=none,aio=threads`,
      "-serial",
      "stdio",
      "-monitor",
      "none",
      "-display",
      "none",
      "-no-reboot",
    ];
    for (const share of uniqueShares(shares)) {
      qemuArgs.push(
        "-virtfs",
        `local,path=${share.hostPath},mount_tag=${share.tag},security_model=none${
          share.readonly ? ",readonly=on" : ""
        }`,
      );
    }
    const result = await runCommand(qemu, qemuArgs, {
      signal: context.signal,
      timeoutMs: BUILD_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    let guestStatus: number;
    try {
      guestStatus = Number.parseInt(
        (await Deno.readTextFile(statusPath)).trim(),
        10,
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new Error(
          `QEMU guest did not report a build status (exit ${result.exitCode}): ${
            (result.stderr || result.stdout).trim()
          }`,
        );
      }
      throw error;
    }
    if (
      !Number.isInteger(guestStatus) || guestStatus !== 0 ||
      result.exitCode !== 0
    ) {
      throw new Error(
        `QEMU rescue build failed (guest=${guestStatus}, qemu=${result.exitCode}): ${
          (result.stderr || result.stdout).trim()
        }`,
      );
    }
    await exportScratchOutput(scratch, args.outputDir, context.signal);
  } finally {
    await Deno.remove(statusPath).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
    if (initramfs) {
      await Deno.remove(initramfs).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
      await Deno.remove(initramfs.slice(0, -3)).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
      await Deno.remove(dirname(initramfs), { recursive: true }).catch(
        (error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        },
      );
    }
    await Deno.remove(temporary, { recursive: true }).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
}

async function executeBuild(
  args: RescueImageArgs,
  context: ModelContext,
  attempt: string,
) {
  if (Deno.build.arch !== "x86_64") {
    throw new Error(
      `rescue image requires x86_64 execution, got ${Deno.build.arch}`,
    );
  }
  if (!/(^|[-_, ])x86_64($|[-_, ])/i.test(args.workerLabel)) {
    throw new Error(`workerLabel must include x86_64: ${args.workerLabel}`);
  }
  if (!SOURCE_COMMIT.test(args.sourceCommit)) {
    throw new Error("sourceCommit must be a lowercase 40-character Git commit");
  }
  await requireCharacterDevice("/dev/kvm", "KVM device");
  const workspaceRoot = await Deno.realPath(args.workspaceRoot);
  const sourcePath = await requireWorkspacePath(
    args.sourcePath,
    workspaceRoot,
    "sourcePath",
    true,
  );
  const outputDir = await requireWorkspacePath(
    args.outputDir,
    workspaceRoot,
    "outputDir",
    false,
  );
  const sentinel = await requireWorkspacePath(
    args.safetySentinelPath,
    workspaceRoot,
    "safetySentinelPath",
    true,
  );
  await requireExistingDirectory(args.swampRepoDir, "swampRepoDir");
  await requireExistingDirectory(args.mereDevRoot, "mereDevRoot");
  await requireExistingFile(args.mereBinary, "mereBinary");
  await requireExistingFile(args.linuxPackage, "linuxPackage");
  const binaryVersion = await runChecked(args.mereBinary, ["--version"], {
    signal: context.signal,
    timeoutMs: 60_000,
    maxOutputBytes: 16 * 1024,
  });
  if (
    !(binaryVersion.stdout + binaryVersion.stderr).includes(args.mereVersion)
  ) {
    throw new Error(
      `Mere binary version does not match mereVersion ${args.mereVersion}`,
    );
  }
  await requireExistingDirectory(args.toolProfileRoot, "toolProfileRoot");
  await requireExistingDirectory(
    args.ovmfToolProfileRoot,
    "ovmfToolProfileRoot",
  );
  await runChecked(
    "git",
    ["-C", sourcePath, "checkout", "--detach", args.sourceCommit],
    {
      signal: context.signal,
      timeoutMs: 60_000,
      maxOutputBytes: 16 * 1024,
    },
  );
  const checkout = await verifyCheckout(
    { ...args, sourcePath },
    context.signal,
  );
  if (!checkout.clean) throw new Error("source checkout is not clean");
  const sentinelBefore = await sha256(sentinel);
  await Deno.mkdir(outputDir, { recursive: true });
  const preparationArgs = [
    `${sourcePath}/misc-util/rescue-image-build`,
    "--prepare-generated-inputs",
    "--build-packages",
    ...(args.includeFixture || args.fullCompare ? ["--include-fixture"] : []),
    "--mere-dev-behavior",
    args.mereDevBehavior,
    "--mere-dev-root",
    args.mereDevRoot,
    "--mere-binary",
    args.mereBinary,
    "--mere-version",
    args.mereVersion,
    "--linux-package",
    args.linuxPackage,
    "--swamp-repo-dir",
    args.swampRepoDir,
    ...(args.swampServerTokenFile
      ? ["--swamp-server-token-file", args.swampServerTokenFile]
      : []),
    "--tool-profile-root",
    args.toolProfileRoot,
    "--ovmf-tool-profile-root",
    args.ovmfToolProfileRoot,
    "--output-dir",
    outputDir,
  ];
  const preparation = await runCommand("python3", preparationArgs, {
    cwd: sourcePath,
    signal: context.signal,
    timeoutMs: BUILD_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  if (preparation.exitCode !== 0) {
    throw new Error(
      `rescue input preparation failed with exit code ${preparation.exitCode}: ${
        preparation.stderr || preparation.stdout
      }`,
    );
  }
  const generated = `${outputDir}/generated-inputs`;
  const includeFixture = args.includeFixture || args.fullCompare;
  const commandArgs = [
    `${sourcePath}/misc-util/rescue-image-build`,
    "--build",
    ...(includeFixture ? ["--include-fixture"] : []),
    ...(args.fullCompare ? ["--compare"] : []),
    "--mere-dev-root",
    args.mereDevRoot,
    "--mere-binary",
    "/bin/mere",
    "--mere-version",
    args.mereVersion,
    "--tool-profile-root",
    args.toolProfileRoot,
    "--root-tree",
    `${generated}/rescue-root`,
    ...(includeFixture
      ? [
        "--fixture-root-tree",
        `${generated}/fixture-root`,
        "--fixture-esp-tree",
        `${generated}/fixture-esp`,
      ]
      : []),
    "--kernel",
    `${generated}/rescue-root/boot/vmlinux`,
    "--limine-efi",
    `${generated}/limine.efi`,
    "--package-manifest",
    `${generated}/package-manifest.json`,
    "--firmware-manifest",
    `${generated}/firmware-manifest.json`,
    "--output-dir",
    outputDir,
  ];
  await runQemuBuild(
    args,
    commandArgs,
    workspaceRoot,
    args.mereDevRoot,
    context,
  );
  const manifestPath = `${outputDir}/manifest.json`;
  const raw = JSON.parse(await Deno.readTextFile(manifestPath)) as Manifest;
  const manifest = validateManifest(
    raw,
    args.sourceCommit,
    outputDir,
    { includeFixture, fullCompare: args.fullCompare },
  );
  const safety = commandSafety(manifest);
  const sentinelAfter = await sha256(sentinel);
  const sentinelUnchanged = sentinelBefore === sentinelAfter;
  const accepted = sentinelUnchanged && safety.unsafe.length === 0 &&
    safety.loopMountsOnly;
  if (!accepted) throw new Error("disk-safety acceptance failed");
  const verifiedManifest: Manifest = {
    ...manifest,
    image_builder_revision: args.sourceCommit,
    provenance: {
      repositoryUrl: args.repositoryUrl,
      verifiedRemote: checkout.remote,
      sourceCommit: args.sourceCommit,
      attempt,
    },
    hostEnvironment: {
      architecture: Deno.build.arch,
      virtualization: "qemu-kvm",
      workerLabel: args.workerLabel,
      environmentProfile: args.environmentProfile,
      deno: Deno.version,
      timezone: "UTC",
      locale: "C.UTF-8",
    },
    diskSafety: {
      sentinelPath: sentinel,
      sentinelSha256Before: sentinelBefore,
      sentinelSha256After: sentinelAfter,
      sentinelUnchanged,
      unsafeCommands: safety.unsafe,
      loopMountsOnly: safety.loopMountsOnly,
    },
  };
  await Deno.writeTextFile(
    manifestPath,
    `${JSON.stringify(verifiedManifest, null, 2)}\n`,
  );
  const manifestSha256 = await sha256(manifestPath);
  const rescue = artifact(verifiedManifest, "rescue");
  const fixture = includeFixture
    ? artifact(verifiedManifest, "fixture")
    : undefined;
  const dirty = args.fullCompare
    ? verifiedManifest.artifacts?.fixture?.dirty_journal
    : undefined;
  if (args.fullCompare && !dirty?.blake3) {
    throw new Error("manifest has no dirty-journal fixture digest");
  }
  const build = {
    attempt,
    sourceCommit: args.sourceCommit,
    mereVersion: args.mereVersion,
    repositoryUrl: args.repositoryUrl,
    verifiedRemote: checkout.remote,
    architecture: "x86_64" as const,
    virtualization: "qemu-kvm" as const,
    workerLabel: args.workerLabel,
    environmentProfile: args.environmentProfile,
    outputDir,
    manifestPath,
    rescueDigest: rescue.blake3,
    fixtureDigest: fixture?.blake3 ?? "",
    dirtyFixtureDigest: dirty?.blake3 ?? "",
    manifestSha256,
    sourceTreeClean: checkout.clean,
    detached: checkout.detached,
  };
  const handles = [
    await context.writeResource("rescue-build", `${attempt}-build`, build),
    await context.writeResource("rescue-manifest", `${attempt}-manifest`, {
      manifestPath,
      sourceCommit: args.sourceCommit,
      repositoryUrl: args.repositoryUrl,
      verifiedRemote: checkout.remote,
      manifest: verifiedManifest,
    }),
    await context.writeResource("rescue-safety", `${attempt}-safety`, {
      sentinelPath: sentinel,
      sentinelSha256Before: sentinelBefore,
      sentinelSha256After: sentinelAfter,
      sentinelUnchanged,
      unsafeCommands: safety.unsafe,
      loopMountsOnly: safety.loopMountsOnly,
      accepted,
    }),
  ];
  return { dataHandles: handles };
}

/** Behavior that builds and verifies a provenance-bound rescue image. */
export const behavior = {
  type: "@jeremy/mere/rescue-image",
  version: "2026.11.05.16",
  description:
    "Build a reproducible x86_64 Mere rescue image from a verified detached Merelinux commit and an isolated workspace.",
  globalArguments: z.object({}),
  resources: {
    "rescue-build": {
      description: "Verified rescue-image build output and digest summary",
      schema: BuildSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "rescue-manifest": {
      description: "Machine-readable rescue-image manifest with provenance",
      schema: ManifestResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "rescue-safety": {
      description:
        "Disk-safety acceptance evidence for one rescue-image attempt",
      schema: SafetySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    build: {
      description:
        "Run the pinned rescue assembler with fixed argv, then verify source provenance, reproducibility, output containment, and disk safety.",
      kind: "action",
      arguments: RescueImageArgsSchema,
      execute: async (
        args: RescueImageArgs,
        context: ModelContext,
      ) => await executeBuild(args, context, "build"),
    },
  },
};
