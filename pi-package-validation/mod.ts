import { z } from "npm:zod@4";

const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_FAILURE_BYTES = 1024;
const MAX_PACK_FILES = 5000;
const COMMAND_TIMEOUT_MS = 120_000;
const NATIVE_SMOKE_MARKER = "PI-PACKAGE-NATIVE-SMOKE-OK";
const NATIVE_SMOKE_PROMPT = `Reply with exactly: ${NATIVE_SMOKE_MARKER}`;
const COMMIT_RE = /^[0-9a-f]{40}$/;

const GlobalArgsSchema = z.object({
  packageRoot: z.string().min(1).refine(
    (value) => value.startsWith("/"),
    "packageRoot must be an absolute path",
  ),
  npmBinaryPath: z.string().default("npm").refine(
    (value) => allowedExecutable(value, "npm"),
    "npmBinaryPath must name npm or an absolute path whose basename is npm",
  ),
  piBinaryPath: z.string().default("pi").refine(
    (value) => allowedExecutable(value, "pi"),
    "piBinaryPath must name pi or an absolute path whose basename is pi",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ResultStatusSchema = z.enum(["passed", "failed", "skipped"]);
const FailureSchema = z.object({
  phase: z.string().min(1),
  detail: z.string().min(1).max(MAX_FAILURE_BYTES),
});
const TestResultSchema = z.object({
  status: ResultStatusSchema,
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
});
const PackFileSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  mode: z.number().int().nonnegative().optional(),
});
type PackFile = z.infer<typeof PackFileSchema>;
const PackResultSchema = z.object({
  status: ResultStatusSchema,
  fileCount: z.number().int().nonnegative(),
  files: z.array(PackFileSchema).max(MAX_PACK_FILES),
  detail: z.string().max(MAX_FAILURE_BYTES).optional(),
});

const PackageValidationSchema = z.object({
  expectedCommit: z.string().regex(COMMIT_RE),
  observedCommit: z.string().regex(COMMIT_RE).optional(),
  commitMatches: z.boolean(),
  clean: z.boolean(),
  packageName: z.string().min(1),
  packageVersion: z.string().min(1),
  status: ResultStatusSchema,
  test: TestResultSchema,
  pack: PackResultSchema,
  artifactDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  failures: z.array(FailureSchema).max(10),
});

const NativeSmokeSchema = z.object({
  expectedCommit: z.string().regex(COMMIT_RE),
  observedCommit: z.string().regex(COMMIT_RE).optional(),
  commitMatches: z.boolean(),
  clean: z.boolean(),
  packageName: z.string().min(1),
  packageVersion: z.string().min(1),
  status: ResultStatusSchema,
  marker: z.literal(NATIVE_SMOKE_MARKER),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  failureDetail: z.string().max(MAX_FAILURE_BYTES).optional(),
});

/** Bounded result from one fixed subprocess invocation. */
export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

/** Injectable command boundary used by unit tests and the behavior methods. */
export type RunCommand = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number },
) => Promise<RunResult>;

/** Run one fixed command with a timeout and bounded captured output. */
export async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number },
): Promise<RunResult> {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // swamp-quality-ignore deno-command
    const output = await new Deno.Command(command, {
      args,
      cwd: options.cwd,
      signal: controller.signal,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: output.code,
      stdout: boundedText(
        new TextDecoder().decode(output.stdout),
        MAX_OUTPUT_BYTES,
      ),
      stderr: boundedText(
        new TextDecoder().decode(output.stderr),
        MAX_OUTPUT_BYTES,
      ),
      timedOut: false,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      code: -1,
      stdout: "",
      stderr: error instanceof Error ? error.name : "command failed",
      timedOut: controller.signal.aborted,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Compute a stable SHA-256 digest over canonical package file metadata and bytes. */
export async function canonicalPackageDigest(
  packageRoot: string,
  packageName: string,
  packageVersion: string,
  files: readonly PackFile[],
): Promise<string> {
  const records: Array<Record<string, unknown>> = [];
  for (
    const entry of [...files].sort((left, right) =>
      left.path.localeCompare(right.path)
    )
  ) {
    const relativePath = safePackagePath(entry.path);
    const absolutePath = `${packageRoot}/${relativePath}`;
    const info = await Deno.lstat(absolutePath);
    if (info.isSymlink) {
      records.push({
        kind: "symlink",
        mode: entry.mode,
        path: relativePath,
        target: await Deno.readLink(absolutePath),
      });
      continue;
    }
    if (!info.isFile) {
      throw new Error(`npm pack entry is not a regular file: ${entry.path}`);
    }
    const bytes = await Deno.readFile(absolutePath);
    records.push({
      bytes: await sha256Hex(bytes),
      kind: "file",
      mode: entry.mode,
      path: relativePath,
      size: bytes.length,
    });
  }

  const canonical = JSON.stringify({
    files: records,
    name: packageName,
    version: packageVersion,
  });
  return `sha256:${await sha256Hex(new TextEncoder().encode(canonical))}`;
}

function allowedExecutable(value: string, expected: string): boolean {
  const basename = value.split("/").at(-1) ?? value;
  return basename === expected || basename === `${expected}.cmd`;
}

function safePackagePath(value: string): string {
  if (value.startsWith("/") || value.split("/").some((part) => part === "..")) {
    throw new Error(`npm pack returned an unsafe path: ${value}`);
  }
  return value.replace(/^\.\//, "");
}

function boundedText(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maxBytes) return value;
  return `${new TextDecoder().decode(bytes.slice(0, maxBytes))}\n[truncated]`;
}

function failureDetail(phase: string, result: RunResult): string {
  if (result.timedOut) {
    return `${phase} timed out after ${COMMAND_TIMEOUT_MS}ms`;
  }
  const output = result.stderr.trim() || result.stdout.trim();
  if (!output) return `${phase} exited with code ${result.code}`;
  return boundedText(
    sanitizeDetail(`${phase} exited with code ${result.code}: ${output}`),
    MAX_FAILURE_BYTES,
  );
}

function sanitizeDetail(value: string): string {
  return value
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://***:***@")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer ***")
    .replace(
      /\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*[^\s]+/gi,
      "$1=***",
    );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function readPackageMetadata(packageRoot: string): Promise<{
  name: string;
  version: string;
  hasTestScript: boolean;
}> {
  const raw = await Deno.readTextFile(`${packageRoot}/package.json`);
  const packageJson = JSON.parse(raw) as {
    name?: unknown;
    version?: unknown;
    scripts?: { test?: unknown };
  };
  if (typeof packageJson.name !== "string" || packageJson.name.length === 0) {
    throw new Error("package.json has no package name");
  }
  if (
    typeof packageJson.version !== "string" || packageJson.version.length === 0
  ) {
    throw new Error("package.json has no package version");
  }
  return {
    name: packageJson.name,
    version: packageJson.version,
    hasTestScript: typeof packageJson.scripts?.test === "string" &&
      packageJson.scripts.test.length > 0,
  };
}

function parsePackManifest(stdout: string): PackFile[] {
  const value = JSON.parse(stdout) as unknown;
  const record = Array.isArray(value) ? value[0] : value;
  if (
    !record || typeof record !== "object" ||
    !Array.isArray((record as { files?: unknown }).files)
  ) {
    throw new Error("npm pack did not return a file manifest");
  }
  const files = (record as { files: unknown[] }).files;
  if (files.length > MAX_PACK_FILES) {
    throw new Error(`npm pack returned more than ${MAX_PACK_FILES} files`);
  }
  return files.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("npm pack returned an invalid file entry");
    }
    const item = entry as { path?: unknown; size?: unknown; mode?: unknown };
    if (typeof item.path !== "string" || typeof item.size !== "number") {
      throw new Error("npm pack returned an incomplete file entry");
    }
    return {
      path: safePackagePath(item.path),
      size: item.size,
      ...(typeof item.mode === "number" ? { mode: item.mode } : {}),
    };
  });
}

function emptyTest(
  status: z.infer<typeof ResultStatusSchema>,
): z.infer<typeof TestResultSchema> {
  return { status, exitCode: -1, durationMs: 0 };
}

function emptyPack(
  status: z.infer<typeof ResultStatusSchema>,
): z.infer<typeof PackResultSchema> {
  return { status, fileCount: 0, files: [] };
}

type Logger = {
  info: (message: string, properties?: Record<string, unknown>) => void;
};
type ResourceContext = {
  globalArgs: GlobalArgs;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

/** Typed Swamp behavior for commit-bound Pi package validation. */
export const model = {
  type: "@jeremy/pi-package-validation",
  version: "2026.10.30.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "package-validation": {
      description:
        "Commit-bound npm test, pack manifest, package version, and deterministic content digest",
      schema: PackageValidationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "native-smoke": {
      description:
        "Bounded Pi native smoke result with marker-only output handling",
      schema: NativeSmokeSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    validate: {
      description:
        "Validate one exact package revision with fixed npm test and pack operations",
      arguments: z.object({ expectedCommit: z.string().regex(COMMIT_RE) }),
      execute: async (
        args: { expectedCommit: string; _run?: RunCommand },
        context: ResourceContext,
      ) => {
        const { packageRoot, npmBinaryPath } = context.globalArgs;
        context.logger.info("starting package validation", {
          packageRoot,
          expectedCommit: args.expectedCommit,
        });
        const doRun = args._run ?? runCommand;
        const failures: Array<{ phase: string; detail: string }> = [];
        let packageName = "unavailable";
        let packageVersion = "unavailable";
        let metadata:
          | { name: string; version: string; hasTestScript: boolean }
          | undefined;
        try {
          metadata = await readPackageMetadata(packageRoot);
          packageName = metadata.name;
          packageVersion = metadata.version;
        } catch (error) {
          failures.push({
            phase: "package",
            detail: sanitizeDetail(
              error instanceof Error ? error.message : String(error),
            ),
          });
        }

        const revision = await doRun("git", [
          "-C",
          packageRoot,
          "rev-parse",
          "--verify",
          "HEAD",
        ], { cwd: packageRoot });
        const observedCommit =
          revision.code === 0 && COMMIT_RE.test(revision.stdout.trim())
            ? revision.stdout.trim()
            : undefined;
        const status = await doRun("git", [
          "-C",
          packageRoot,
          "status",
          "--porcelain",
          "--untracked-files=all",
        ], { cwd: packageRoot });
        const clean = status.code === 0 && status.stdout.trim().length === 0;
        const commitMatches = observedCommit === args.expectedCommit;
        if (!commitMatches) {
          failures.push({
            phase: "revision",
            detail: observedCommit
              ? `expected ${args.expectedCommit}, observed ${observedCommit}`
              : failureDetail("git revision", revision),
          });
        }
        if (!clean) {
          failures.push({
            phase: "revision",
            detail: status.code === 0
              ? "checkout is dirty"
              : failureDetail("git status", status),
          });
        }

        let test = emptyTest("skipped");
        let pack = emptyPack("skipped");
        let artifactDigest: string | undefined;
        if (metadata?.hasTestScript && commitMatches && clean) {
          const testRun = await doRun(npmBinaryPath, ["test"], {
            cwd: packageRoot,
          });
          test = toTestResult(testRun);
          if (test.status === "failed") {
            failures.push({
              phase: "test",
              detail: failureDetail("npm test", testRun),
            });
          }
        } else if (!metadata?.hasTestScript) {
          failures.push({
            phase: "test",
            detail: "package.json has no declared test script",
          });
        }

        if (test.status === "passed" && commitMatches && clean) {
          const packRun = await doRun(npmBinaryPath, [
            "pack",
            "--dry-run",
            "--json",
          ], { cwd: packageRoot });
          if (packRun.code === 0 && !packRun.timedOut) {
            try {
              const files = parsePackManifest(packRun.stdout);
              pack = { status: "passed", fileCount: files.length, files };
              artifactDigest = await canonicalPackageDigest(
                packageRoot,
                packageName,
                packageVersion,
                files,
              );
            } catch (error) {
              const detail = sanitizeDetail(
                error instanceof Error ? error.message : String(error),
              );
              pack = { status: "failed", fileCount: 0, files: [], detail };
              failures.push({ phase: "pack", detail });
            }
          } else {
            const detail = failureDetail("npm pack", packRun);
            pack = { status: "failed", fileCount: 0, files: [], detail };
            failures.push({ phase: "pack", detail });
          }
        }

        const result = {
          expectedCommit: args.expectedCommit,
          ...(observedCommit ? { observedCommit } : {}),
          commitMatches,
          clean,
          packageName,
          packageVersion,
          status: failures.length === 0 && test.status === "passed" &&
              pack.status === "passed"
            ? "passed" as const
            : "failed" as const,
          test,
          pack,
          ...(artifactDigest ? { artifactDigest } : {}),
          failures: failures.map((failure) => ({
            phase: failure.phase,
            detail: boundedText(
              sanitizeDetail(failure.detail),
              MAX_FAILURE_BYTES,
            ),
          })),
        };
        const handle = await context.writeResource(
          "package-validation",
          "validation",
          result,
        );
        context.logger.info("package validation completed", {
          status: result.status,
          packageName,
          packageVersion,
          commitMatches,
          clean,
        });
        return { dataHandles: [handle] };
      },
    },
    native_smoke: {
      description:
        "Run the fixed marker-only Pi native smoke for one exact package revision",
      arguments: z.object({ expectedCommit: z.string().regex(COMMIT_RE) }),
      execute: async (
        args: { expectedCommit: string; _run?: RunCommand },
        context: ResourceContext,
      ) => {
        const { packageRoot, piBinaryPath } = context.globalArgs;
        context.logger.info("starting native smoke", {
          packageRoot,
          expectedCommit: args.expectedCommit,
        });
        const doRun = args._run ?? runCommand;
        let packageName = "unavailable";
        let packageVersion = "unavailable";
        try {
          const metadata = await readPackageMetadata(packageRoot);
          packageName = metadata.name;
          packageVersion = metadata.version;
        } catch {
          // The smoke still records a bounded failure below.
        }
        const revision = await doRun("git", [
          "-C",
          packageRoot,
          "rev-parse",
          "--verify",
          "HEAD",
        ], { cwd: packageRoot });
        const observedCommit =
          revision.code === 0 && COMMIT_RE.test(revision.stdout.trim())
            ? revision.stdout.trim()
            : undefined;
        const status = await doRun("git", [
          "-C",
          packageRoot,
          "status",
          "--porcelain",
          "--untracked-files=all",
        ], { cwd: packageRoot });
        const clean = status.code === 0 && status.stdout.trim().length === 0;
        const commitMatches = observedCommit === args.expectedCommit;
        let smoke = emptySmoke(
          "skipped",
          commitMatches,
          clean,
          args.expectedCommit,
          observedCommit,
          packageName,
          packageVersion,
        );
        if (!commitMatches || !clean) {
          smoke = {
            ...smoke,
            status: "failed",
            failureDetail: !commitMatches
              ? "package revision does not match expected commit"
              : "checkout is dirty",
          };
        } else {
          const result = await doRun(piBinaryPath, [
            "-e",
            packageRoot,
            NATIVE_SMOKE_PROMPT,
          ], { cwd: packageRoot });
          const passed = result.code === 0 && !result.timedOut &&
            result.stdout.trim() === NATIVE_SMOKE_MARKER;
          smoke = {
            ...smoke,
            status: passed ? "passed" : "failed",
            exitCode: result.code,
            durationMs: result.durationMs,
            ...(passed ? {} : {
              failureDetail: result.timedOut
                ? `native smoke timed out after ${COMMAND_TIMEOUT_MS}ms`
                : `native smoke did not return the expected marker (exit ${result.code})`,
            }),
          };
        }
        const handle = await context.writeResource(
          "native-smoke",
          "native-smoke",
          smoke,
        );
        context.logger.info("native smoke completed", {
          status: smoke.status,
          packageName,
          packageVersion,
          commitMatches,
          clean,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

function toTestResult(result: RunResult): z.infer<typeof TestResultSchema> {
  return {
    status: result.code === 0 && !result.timedOut ? "passed" : "failed",
    exitCode: result.code,
    durationMs: result.durationMs,
  };
}

function emptySmoke(
  status: z.infer<typeof ResultStatusSchema>,
  commitMatches: boolean,
  clean: boolean,
  expectedCommit: string,
  observedCommit: string | undefined,
  packageName: string,
  packageVersion: string,
): z.infer<typeof NativeSmokeSchema> {
  return {
    expectedCommit,
    ...(observedCommit ? { observedCommit } : {}),
    commitMatches,
    clean,
    packageName,
    packageVersion,
    status,
    marker: NATIVE_SMOKE_MARKER,
    exitCode: -1,
    durationMs: 0,
  };
}
