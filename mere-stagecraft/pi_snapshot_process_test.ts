import { captureProcess } from "./pi_snapshot_process.ts";

function assert(value: unknown): asserts value {
  if (!value) throw new Error("assertion failed");
}
async function refuses(work: () => Promise<unknown>, reason: string) {
  try {
    await work();
  } catch (error) {
    assert(error instanceof Error && error.message === reason);
    return;
  }
  throw new Error("expected refusal: " + reason);
}
function child(
  script: string,
  overrides: Partial<Parameters<typeof captureProcess>[0]> = {},
) {
  return captureProcess({
    executable: Deno.execPath(),
    args: ["eval", script],
    stdin: "",
    cwd: Deno.cwd(),
    env: {},
    timeoutMs: 5000,
    signal: new AbortController().signal,
    ...overrides,
  });
}
Deno.test("process adapter captures stdout separately and returns actual nonzero exit", async () => {
  const result = await child(
    'console.log("stdout"); console.error("stderr"); Deno.exit(3)',
  );
  assert(result.stdout === "stdout\n" && result.exitCode === 3);
});
Deno.test("process adapter sends literal stdin and uses only the supplied environment", async () => {
  const result = await child(
    "const text = await new Response(Deno.stdin.readable).text(); console.log(JSON.stringify({text, keys:Object.keys(Deno.env.toObject())}))",
    {
      stdin: "@private\n$(not-a-command)",
      env: { PROOF_ONLY: "yes" },
    },
  );
  const value = JSON.parse(result.stdout);
  assert(value.text === "@private\n$(not-a-command)");
  assert(value.keys.includes("PROOF_ONLY"));
  // Deno may synthesize its own PATH and shim marker after startup.
  assert(
    value.keys.every((key: string) =>
      ["PROOF_ONLY", "PATH", "DENO_NODE_SHIM_ACTIVE"].includes(key)
    ),
  );
});
Deno.test("process adapter bounds stdout and stderr while streaming", async () => {
  await refuses(
    () => child('console.log("x".repeat(1024))', { stdoutLimit: 16 }),
    "pi-output-limit",
  );
  await refuses(
    () => child('console.error("x".repeat(1024))', { stderrLimit: 16 }),
    "pi-stderr-limit",
  );
});
Deno.test("process adapter kills and reaps a timed-out child", async () => {
  await refuses(
    () =>
      child("await new Promise(r=>setTimeout(r,60000))", { timeoutMs: 100 }),
    "pi-timeout",
  );
});
Deno.test("process adapter kills and reaps a cancelled child", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await refuses(
      () =>
        child("await new Promise(r=>setTimeout(r,60000))", {
          signal: controller.signal,
        }),
      "pi-cancelled",
    );
  } finally {
    clearTimeout(timer);
  }
});
Deno.test("timeout escalates when the direct child ignores SIGTERM", async () => {
  if (Deno.build.os === "windows") return;
  await refuses(() =>
    child(
      'Deno.addSignalListener("SIGTERM",()=>{}); await new Promise(r=>setTimeout(r,60000))',
      { timeoutMs: 200 },
    ), "pi-timeout");
});
Deno.test("invalid output encoding fails without returning raw child bytes", async () => {
  await refuses(
    () => child("await Deno.stdout.write(new Uint8Array([255]))"),
    "pi-invalid-utf8",
  );
});
Deno.test("already-cancelled work does not spawn", async () => {
  const controller = new AbortController();
  controller.abort();
  await refuses(
    () =>
      child('throw new Error("must not run")', { signal: controller.signal }),
    "pi-cancelled",
  );
});
