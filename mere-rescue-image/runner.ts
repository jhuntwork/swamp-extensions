export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  durationMs: number;
}

/** Drain both pipes while retaining only a bounded tail from each. */
export async function runCommand(
  command: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    maxOutputBytes?: number;
  } = {},
): Promise<CommandResult> {
  const limit = options.maxOutputBytes ?? 64 * 1024;
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("maxOutputBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive safe integer");
  }
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(timeoutMs),
  ]);
  signal.throwIfAborted();
  const start = performance.now();
  // Mere is a local CLI; direct argv execution avoids shell interpolation.
  // swamp-quality-ignore deno-command
  const child = new Deno.Command(command, {
    args,
    cwd: options.cwd,
    env: options.env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const abort = () => {
    try {
      child.kill("SIGKILL");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  async function capture(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    let tail = new Uint8Array(0);
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        const kept = value.subarray(Math.max(0, value.length - limit));
        const previous = tail.subarray(
          Math.max(0, tail.length - (limit - kept.length)),
        );
        const next = new Uint8Array(previous.length + kept.length);
        next.set(previous);
        next.set(kept, previous.length);
        tail = next;
      }
    } finally {
      reader.releaseLock();
    }
    return { text: new TextDecoder().decode(tail), total };
  }
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.status,
      capture(child.stdout),
      capture(child.stderr),
    ]);
    signal.throwIfAborted();
    return {
      exitCode: status.code,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutBytes: stdout.total,
      stderrBytes: stderr.total,
      truncated: stdout.total > limit || stderr.total > limit,
      durationMs: performance.now() - start,
    };
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Like runCommand, but throws (with a bounded tail) on a nonzero exit. */
export async function runChecked(
  command: string,
  args: string[],
  options: Parameters<typeof runCommand>[2] = {},
): Promise<CommandResult> {
  const result = await runCommand(command, args, options);
  if (result.exitCode !== 0) {
    const tail = (result.stderr || result.stdout).trim();
    throw new Error(
      `${command} exited with code ${result.exitCode}${
        tail ? `: ${tail}` : ""
      }`,
    );
  }
  return result;
}
