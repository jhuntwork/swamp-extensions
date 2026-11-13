import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  developmentSigningKeyPath,
  parseBlake3Output,
  parseSha256Sums,
  runCommand,
} from "./mod.ts";

const digest = "a".repeat(64);

Deno.test("developmentSigningKeyPath uses Mere's standard per-user location", () => {
  assertEquals(
    developmentSigningKeyPath("/home/developer"),
    "/home/developer/.mere/keys/mere.key",
  );
});

Deno.test("parseBlake3Output extracts digest from digest-plus-path output", () => {
  assertEquals(
    parseBlake3Output(`${digest}  /tmp/source.tar.gz\n`),
    digest,
  );
});

Deno.test("parseBlake3Output accepts digest-only output and normalizes case", () => {
  assertEquals(parseBlake3Output(`${"A".repeat(64)}\n`), digest);
});

Deno.test("parseBlake3Output rejects output without a canonical digest", () => {
  assertThrows(
    () => parseBlake3Output("not-a-hash /tmp/source.tar.gz\n"),
    Error,
    "Could not parse a BLAKE3 digest",
  );
});

Deno.test("parseBlake3Output rejects truncated digests", () => {
  assertThrows(
    () => parseBlake3Output(`${"a".repeat(63)}  /tmp/source.tar.gz\n`),
    Error,
    "Could not parse a BLAKE3 digest",
  );
});

Deno.test("parseSha256Sums extracts the exact release asset digest", () => {
  assertEquals(
    parseSha256Sums(
      `${"A".repeat(64)}  mere-0.23.0-linux-x86_64\n`,
      "mere-0.23.0-linux-x86_64",
    ),
    "a".repeat(64),
  );
});

Deno.test("parseSha256Sums rejects a missing release asset", () => {
  assertThrows(
    () => parseSha256Sums(`${"a".repeat(64)}  other\n`, "mere"),
    Error,
    "no entry",
  );
});

Deno.test("packaged MereLinux workflow preserves the recipe delivery boundaries", async () => {
  const workflow = await Deno.readTextFile(
    new URL("./merelinux-change.yaml", import.meta.url),
  );
  for (
    const required of [
      'name: "@jeremy/merelinux-change"',
      "methodName: validate",
      "methodName: build",
      "methodName: importOutputs",
      "methodName: run",
      "workdir: /",
      'workflowIdOrName: "@jeremy/mere-delivery/deliver-change"',
      "profile: merelinux",
      "repository: jhuntwork/merelinux",
    ]
  ) {
    assertStringIncludes(workflow, required);
  }
  assertEquals(workflow.includes("workdir: ${{ inputs.worktreePath }}"), false);
  // Committing and publishing belong to mere-delivery; this workflow must not.
  assertEquals(workflow.includes("methodName: commit"), false);
  assertEquals(workflow.includes("methodName: push"), false);
});

Deno.test({
  name: "runCommand terminates a controlled child when its signal aborts",
  permissions: { run: true },
  async fn() {
    const controller = new AbortController();
    const pending = runCommand(Deno.execPath(), {
      args: [
        "eval",
        "await new Promise((resolve) => setTimeout(resolve, 10_000))",
      ],
      stdout: "piped",
      stderr: "piped",
    }, controller.signal);
    setTimeout(() => controller.abort(), 25);
    const output = await pending;
    assertEquals(output.success, false);
  },
});

Deno.test("each result resource is written under its own spec name", async () => {
  // The workflow queries by specName within one run. Writing every spec to the
  // same instance name ("current") makes each write supersede the previous
  // spec's record, so an earlier result (for example validation-result) is
  // unreachable once a later method runs in the same workflow.
  const source = await Deno.readTextFile(new URL("./mod.ts", import.meta.url));
  const writes = [
    ...source.matchAll(/writeResource\(\s*"([a-z-]+)",\s*"([a-z-]+)"/g),
  ];
  assertEquals(writes.length > 0, true);
  for (const [, spec, instance] of writes) {
    assertEquals(instance, spec, `${spec} must not share an instance name`);
  }
});
