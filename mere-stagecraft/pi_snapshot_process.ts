/** Bounded direct-child execution for snapshot-only Pi tasks. No shell is used. */
export async function captureProcess(options: {
  executable: string;
  args: string[];
  stdin: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  stdoutLimit?: number;
  stderrLimit?: number;
}) {
  if (options.signal.aborted) throw new Error("pi-cancelled");
  // swamp-quality-ignore deno-command: fixed Pi argv, bounded pipes and explicit environment.
  const child = new Deno.Command(options.executable, {
    args: options.args,
    cwd: options.cwd,
    clearEnv: true,
    env: options.env,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let failure: string | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  function stop(reason: string) {
    if (failure) return;
    failure = reason;
    try {
      child.kill("SIGTERM");
    } catch { /* already exited */ }
    escalation = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
    }, 1000);
  }
  const abort = () => stop("pi-cancelled");
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  const timer = setTimeout(() => stop("pi-timeout"), options.timeoutMs);
  async function read(
    stream: ReadableStream<Uint8Array>,
    limit: number,
    reason: string,
  ) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > limit) {
        stop(reason);
        continue;
      }
      if (!failure) chunks.push(chunk);
    }
    const bytes = new Uint8Array(
      chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    );
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (failure) return "";
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      stop("pi-invalid-utf8");
      return "";
    }
  }
  const stdout = read(
    child.stdout,
    options.stdoutLimit ?? 4 * 1024 * 1024,
    "pi-output-limit",
  );
  const stderr = read(
    child.stderr,
    options.stderrLimit ?? 64 * 1024,
    "pi-stderr-limit",
  );
  async function send() {
    const writer = child.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(options.stdin));
      await writer.close();
    } catch {
      stop("pi-stdin-failed");
    } finally {
      writer.releaseLock();
    }
  }
  try {
    const [status, output] = await Promise.all([
      child.status,
      stdout,
      stderr,
      send(),
    ]);
    if (failure) throw new Error(failure);
    return { stdout: output, exitCode: status.code, pid: child.pid };
  } finally {
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    options.signal.removeEventListener("abort", abort);
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
    await child.status;
  }
}

/** Only login/config discovery and locale are inherited; never control tokens or API keys. */
export function piEnvironment(
  read: (name: string) => string | undefined = (name) => Deno.env.get(name),
): Record<string, string> {
  const env: Record<string, string> = {};
  for (
    const name of [
      "HOME",
      "PATH",
      "LANG",
      "LC_ALL",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ]
  ) {
    const value = read(name);
    if (value !== undefined) env[name] = value;
  }
  return env;
}
