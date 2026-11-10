import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import {
  escapeSqlString,
  model,
  packageNameFromArchive,
  parseBuildOutput,
  waitForPath,
} from "./mere_pkgd_harness.ts";

Deno.test("parseBuildOutput extracts workspace and a single archive", () => {
  const output = [
    "workspace: /tmp/mere-build-xyz",
    "output: jq-1.8.1-4-x86_64-abc123.pkg.tar.zst",
  ].join("\n");
  const result = parseBuildOutput(output);
  assertEquals(result.workspace, "/tmp/mere-build-xyz");
  assertEquals(result.archiveNames, ["jq-1.8.1-4-x86_64-abc123.pkg.tar.zst"]);
});

Deno.test("parseBuildOutput extracts multiple archives from one build", () => {
  const output = [
    "workspace: /tmp/mere-build-xyz",
    "output: foo-1.0.0-1-x86_64-aaa111.pkg.tar.zst",
    "output: foo-doc-1.0.0-1-x86_64-bbb222.pkg.tar.zst",
  ].join("\n");
  const result = parseBuildOutput(output);
  assertEquals(result.archiveNames, [
    "foo-1.0.0-1-x86_64-aaa111.pkg.tar.zst",
    "foo-doc-1.0.0-1-x86_64-bbb222.pkg.tar.zst",
  ]);
});

Deno.test("parseBuildOutput throws when no workspace line is present", () => {
  assertThrows(
    () => parseBuildOutput("output: jq-1.8.1-4-x86_64-abc123.pkg.tar.zst"),
    Error,
    "workspace",
  );
});

Deno.test("parseBuildOutput throws when no output lines are present", () => {
  assertThrows(
    () => parseBuildOutput("workspace: /tmp/mere-build-xyz"),
    Error,
    "output archives",
  );
});

Deno.test("packageNameFromArchive strips version/release/arch/hash suffix", () => {
  assertEquals(
    packageNameFromArchive("jq-1.8.1-4-x86_64-abc123.pkg.tar.zst"),
    "jq",
  );
  assertEquals(
    packageNameFromArchive("foo-doc-1.0.0-1-x86_64-bbb222.pkg.tar.zst"),
    "foo-doc",
  );
});

Deno.test("parseBuildOutput rejects archive path traversal", () => {
  assertThrows(
    () =>
      parseBuildOutput([
        "workspace: /tmp/mere-build-xyz",
        "output: ../evil-1.0.0-1-x86_64-abc123.pkg.tar.zst",
      ].join("\n")),
    Error,
    "Invalid package archive name",
  );
});

Deno.test("method schemas reject non-HTTP source URLs", () => {
  assertThrows(() =>
    model.methods.hash_source.arguments.parse({
      url: "file:///etc/passwd",
    })
  );
});

Deno.test("escapeSqlString doubles embedded single quotes", () => {
  assertEquals(escapeSqlString("o'brien"), "o''brien");
  assertEquals(escapeSqlString("plain"), "plain");
  assertEquals(
    escapeSqlString("'; drop table packages; --"),
    "''; drop table packages; --",
  );
});

Deno.test("waitForPath rejects when pkgd never creates its socket", async () => {
  await assertRejects(
    () =>
      waitForPath("/scratch/pkgd.sock", {
        attempts: 2,
        delayMs: 0,
        stat: () => Promise.reject(new Error("missing")),
      }),
    Error,
    "Timed out waiting for pkgd",
  );
});

Deno.test("build compiles both binaries and records their paths", async () => {
  const scratchDir = await Deno.makeTempDir({ prefix: "mere-pkgd-harness-" });
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {
      mereRepoPath: "/repos/mere",
      pkgdRepoPath: "/repos/pkgd",
      scratchDir,
    },
  });

  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fakeMustRun = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return Promise.resolve("");
  };

  await model.methods.build.execute(
    { _mustRun: fakeMustRun as never },
    // createModelTestContext isn't generic over the global-args shape, so
    // its context.globalArgs is Record<string, unknown> — cast to satisfy
    // this model's narrower inline context type (see typing.md).
    context as never,
  );

  assertEquals(calls[0], { cmd: "zig", args: ["build"] });
  assertEquals(calls[1], {
    cmd: "go",
    args: ["build", "-o", `${scratchDir}/bin/pkgd`, "./cmd/pkgd"],
  });

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "build");
  assertEquals(written[0].data.mereBinPath, "/repos/mere/zig-out/bin/mere");
  assertEquals(written[0].data.pkgdBinPath, `${scratchDir}/bin/pkgd`);
  await Deno.remove(scratchDir, { recursive: true });
});

Deno.test("verify_published rejects a query when sqlite3 exits non-zero", async () => {
  const { context } = createModelTestContext({
    storedResources: {
      "instance": {
        pid: 1,
        socketPath: "/scratch/pkgd.sock",
        mereRoot: "/scratch/mere-root",
        devRepoName: "harness",
        outputDir: "/scratch/output",
        keyDir: "/scratch/keys",
        publishToken: "test-token",
        mereBinPath: "/repos/mere/zig-out/bin/mere",
      },
    },
  });

  const fakeRun = () =>
    Promise.resolve({ code: 1, stdout: "", stderr: "unable to open database" });

  await assertRejects(
    () =>
      model.methods.verify_published.execute(
        { packageName: "jq", _run: fakeRun as never },
        context,
      ),
    Error,
    "sqlite3 query",
  );
});

Deno.test("verify_published reports not-found (not a failure) on empty result", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    storedResources: {
      "instance": {
        pid: 1,
        socketPath: "/scratch/pkgd.sock",
        mereRoot: "/scratch/mere-root",
        devRepoName: "harness",
        outputDir: "/scratch/output",
        keyDir: "/scratch/keys",
        publishToken: "test-token",
        mereBinPath: "/repos/mere/zig-out/bin/mere",
      },
    },
  });

  const fakeRun = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });

  await model.methods.verify_published.execute(
    { packageName: "nonexistent", _run: fakeRun as never },
    context,
  );

  const written = getWrittenResources();
  assertEquals(written[0].data.foundInRepoDb, false);
  assertEquals(written[0].data.version, null);
});

Deno.test("verify_published accepts a safe package name in the sqlite query", async () => {
  const { context } = createModelTestContext({
    storedResources: {
      "instance": {
        pid: 1,
        socketPath: "/scratch/pkgd.sock",
        mereRoot: "/scratch/mere-root",
        devRepoName: "harness",
        outputDir: "/scratch/output",
        keyDir: "/scratch/keys",
        publishToken: "test-token",
        mereBinPath: "/repos/mere/zig-out/bin/mere",
      },
    },
  });

  let capturedArgs: string[] = [];
  const fakeRun = (_cmd: string, args: string[]) => {
    capturedArgs = args;
    return Promise.resolve({ code: 0, stdout: "1.0.0", stderr: "" });
  };

  await model.methods.verify_published.execute(
    { packageName: "o-brien", _run: fakeRun as never },
    context,
  );

  assertEquals(
    capturedArgs[1],
    "select version from packages where name = 'o-brien';",
  );
});

Deno.test("model exposes the upgraded harness contract", () => {
  assertEquals(model.version, "2026.11.10.1");
  assertEquals(model.upgrades?.[0]?.toVersion, "2026.11.10.1");
});
