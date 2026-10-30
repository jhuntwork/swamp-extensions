import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import {
  canonicalPackageDigest,
  model,
  type RunCommand,
  type RunResult,
} from "./mod.ts";

const COMMIT = "f".repeat(40);

function contextFor(packageRoot: string) {
  return createModelTestContext({
    globalArgs: {
      packageRoot,
      npmBinaryPath: "npm",
      piBinaryPath: "pi",
    },
  });
}

function successfulRun(stdout = ""): RunResult {
  return { code: 0, stdout, stderr: "", timedOut: false, durationMs: 4 };
}

async function fixture(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "pi-package-validation-" });
  await Deno.writeTextFile(
    `${root}/package.json`,
    JSON.stringify({
      name: "@example/pi-package",
      version: "1.2.3",
      scripts: { test: "node tests/run.mjs" },
    }),
  );
  await Deno.writeTextFile(`${root}/README.md`, "fixture package\n");
  return root;
}

function fakePackageRun(
  calls: Array<{ command: string; args: string[] }>,
): RunCommand {
  return (command, args) => {
    calls.push({ command, args });
    if (command === "git" && args.includes("rev-parse")) {
      return Promise.resolve(successfulRun(`${COMMIT}\n`));
    }
    if (command === "git" && args.includes("status")) {
      return Promise.resolve(successfulRun());
    }
    if (command === "npm" && args[0] === "test") {
      return Promise.resolve(successfulRun("offline test passed\n"));
    }
    if (command === "npm" && args[0] === "pack") {
      return Promise.resolve(successfulRun(JSON.stringify([{
        name: "@example/pi-package",
        version: "1.2.3",
        files: [
          { path: "README.md", size: 16, mode: 420 },
          { path: "package.json", size: 104, mode: 420 },
        ],
      }])));
    }
    throw new Error(
      `unexpected command in fixture: ${command} ${args.join(" ")}`,
    );
  };
}

Deno.test("validate records commit-bound package evidence without raw command output", async () => {
  const root = await fixture();
  const calls: Array<{ command: string; args: string[] }> = [];
  const { context, getWrittenResources } = contextFor(root);

  await model.methods.validate.execute(
    { expectedCommit: COMMIT, _run: fakePackageRun(calls) },
    context as never,
  );

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "package-validation");
  assertEquals(written[0].data.status, "passed");
  assertEquals(written[0].data.commitMatches, true);
  assertEquals(written[0].data.clean, true);
  assertEquals(written[0].data.packageVersion, "1.2.3");
  assertStringIncludes(String(written[0].data.artifactDigest), "sha256:");
  assertEquals(calls.map((call) => `${call.command} ${call.args[0]}`), [
    "git -C",
    "git -C",
    "npm test",
    "npm pack",
  ]);
  assertEquals(
    JSON.stringify(written[0].data).includes("offline test passed"),
    false,
  );
});

Deno.test("validate refuses a dirty checkout before invoking npm", async () => {
  const root = await fixture();
  const calls: Array<{ command: string; args: string[] }> = [];
  const { context, getWrittenResources } = contextFor(root);
  const run: RunCommand = (command, args) => {
    calls.push({ command, args });
    if (command === "git" && args.includes("rev-parse")) {
      return Promise.resolve(successfulRun(`${COMMIT}\n`));
    }
    if (command === "git" && args.includes("status")) {
      return Promise.resolve(successfulRun(" M src/provider.ts\n"));
    }
    throw new Error("npm must not run for a dirty checkout");
  };

  await model.methods.validate.execute(
    { expectedCommit: COMMIT, _run: run },
    context as never,
  );

  const data = getWrittenResources()[0].data;
  assertEquals(data.status, "failed");
  assertEquals(data.clean, false);
  assertEquals(calls.some((call) => call.command === "npm"), false);
});

Deno.test("validate records a bounded npm pack failure", async () => {
  const root = await fixture();
  const { context, getWrittenResources } = contextFor(root);
  const run: RunCommand = (command, args) => {
    if (command === "git" && args.includes("rev-parse")) {
      return Promise.resolve(successfulRun(`${COMMIT}\n`));
    }
    if (command === "git" && args.includes("status")) {
      return Promise.resolve(successfulRun());
    }
    if (command === "npm" && args[0] === "test") {
      return Promise.resolve(successfulRun("offline test passed\n"));
    }
    if (command === "npm" && args[0] === "pack") {
      return Promise.resolve({
        code: 17,
        stdout: "",
        stderr: "pack failed token=secret-value",
        timedOut: false,
        durationMs: 5,
      });
    }
    throw new Error(`unexpected command: ${command}`);
  };

  await model.methods.validate.execute(
    { expectedCommit: COMMIT, _run: run },
    context as never,
  );

  const data = getWrittenResources()[0].data as {
    status: string;
    pack: { status: string; detail?: string };
  };
  assertEquals(data.status, "failed");
  assertEquals(data.pack.status, "failed");
  assertEquals(String(data.pack.detail).includes("secret-value"), false);
});

Deno.test("native_smoke records timeout without provider output", async () => {
  const root = await fixture();
  const { context, getWrittenResources } = contextFor(root);
  const run: RunCommand = (command, args) => {
    if (command === "git" && args.includes("rev-parse")) {
      return Promise.resolve(successfulRun(`${COMMIT}\n`));
    }
    if (command === "git" && args.includes("status")) {
      return Promise.resolve(successfulRun());
    }
    if (command === "pi") {
      return Promise.resolve({
        code: -1,
        stdout: "unbounded provider response",
        stderr: "",
        timedOut: true,
        durationMs: 120_000,
      });
    }
    throw new Error(`unexpected command: ${command}`);
  };

  await model.methods.native_smoke.execute(
    { expectedCommit: COMMIT, _run: run },
    context as never,
  );

  const data = getWrittenResources()[0].data;
  assertEquals(data.status, "failed");
  assertStringIncludes(String(data.failureDetail), "timed out");
  assertEquals(
    JSON.stringify(data).includes("unbounded provider response"),
    false,
  );
});

Deno.test("native_smoke records only the fixed marker result", async () => {
  const root = await fixture();
  const { context, getWrittenResources } = contextFor(root);
  const run: RunCommand = (command, args) => {
    if (command === "git" && args.includes("rev-parse")) {
      return Promise.resolve(successfulRun(`${COMMIT}\n`));
    }
    if (command === "git" && args.includes("status")) {
      return Promise.resolve(successfulRun());
    }
    if (command === "pi") {
      return Promise.resolve(successfulRun("PI-PACKAGE-NATIVE-SMOKE-OK\n"));
    }
    throw new Error(`unexpected command: ${command}`);
  };

  await model.methods.native_smoke.execute(
    { expectedCommit: COMMIT, _run: run },
    context as never,
  );

  const data = getWrittenResources()[0].data;
  assertEquals(data.status, "passed");
  assertEquals(data.marker, "PI-PACKAGE-NATIVE-SMOKE-OK");
  assertEquals("response" in data, false);
});

Deno.test("native_smoke does not persist provider output on failure", async () => {
  const root = await fixture();
  const { context, getWrittenResources } = contextFor(root);
  const run: RunCommand = (command, args) => {
    if (command === "git" && args.includes("rev-parse")) {
      return Promise.resolve(successfulRun(`${COMMIT}\n`));
    }
    if (command === "git" && args.includes("status")) {
      return Promise.resolve(successfulRun());
    }
    if (command === "pi") {
      return Promise.resolve({
        ...successfulRun("secret provider response"),
        code: 0,
      });
    }
    throw new Error(`unexpected command: ${command}`);
  };

  await model.methods.native_smoke.execute(
    { expectedCommit: COMMIT, _run: run },
    context as never,
  );

  const data = getWrittenResources()[0].data;
  assertEquals(data.status, "failed");
  assertEquals(
    JSON.stringify(data).includes("secret provider response"),
    false,
  );
});

Deno.test("canonicalPackageDigest is independent of manifest order", async () => {
  const root = await fixture();
  const first = await canonicalPackageDigest(
    root,
    "@example/pi-package",
    "1.2.3",
    [
      { path: "package.json", size: 104, mode: 420 },
      { path: "README.md", size: 16, mode: 420 },
    ],
  );
  const second = await canonicalPackageDigest(
    root,
    "@example/pi-package",
    "1.2.3",
    [
      { path: "README.md", size: 16, mode: 420 },
      { path: "package.json", size: 104, mode: 420 },
    ],
  );
  assertEquals(first, second);
});

Deno.test("canonicalPackageDigest rejects path traversal", async () => {
  const root = await fixture();
  await assertRejects(
    () =>
      canonicalPackageDigest(root, "@example/pi-package", "1.2.3", [
        { path: "../secret", size: 1 },
      ]),
    Error,
    "unsafe path",
  );
});
