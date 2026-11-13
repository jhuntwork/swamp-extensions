import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import { join } from "node:path";
import {
  developmentSigningKeyPath,
  firstLine,
  model,
  parseBlake3Output,
  parseSha256Sums,
  recipeFile,
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

// --- validate, build and importOutputs against a fake mere binary ----------

const RECIPE = `recipe {
    name "demo"
    version "1.0"
    release 1
    description "A demo recipe"
    url "https://example.org/demo"
    licenses "MIT"
    archs "x86_64"
}

source "https://example.org/demo-\${recipe.version}.tar.gz" {
    blake3 "${"0".repeat(64)}"
}

build {
    script r#"
        true
    "#
}

package "demo" {
    files "usr/bin/demo"
}
`;

type Written = { spec: string; name: string; data: Record<string, unknown> };

/**
 * A scratch HOME (with the development signing key), a mere root, a checkout
 * holding one recipe, and a shell script standing in for the mere binary.
 */
async function fixture(script: string) {
  const base = await Deno.makeTempDir({ prefix: "mere-dev-fake-" });
  const home = join(base, "home");
  await Deno.mkdir(join(home, ".mere", "keys"), { recursive: true });
  await Deno.writeTextFile(join(home, ".mere", "keys", "mere.key"), "k");
  const checkout = join(base, "checkout");
  await Deno.mkdir(join(checkout, "recipes", "core", "demo"), {
    recursive: true,
  });
  await Deno.writeTextFile(
    join(checkout, "recipes", "core", "demo", "recipe.kdl"),
    RECIPE,
  );
  const root = join(base, "root");
  await Deno.mkdir(join(root, "mere", "store"), { recursive: true });
  await Deno.mkdir(join(root, "mere", "keys"), { recursive: true });
  await Deno.writeTextFile(join(root, "mere", "config.kdl"), "");
  await Deno.writeTextFile(join(root, "mere", "keys", "mere.pub"), "p");
  const binary = join(base, "mere");
  await Deno.writeTextFile(binary, `#!/bin/sh\n${script}\n`);
  await Deno.chmod(binary, 0o755);
  const written: Written[] = [];
  const files: string[] = [];
  const context = {
    globalArgs: {
      mereVersion: "latest",
      mereBinaryPath: binary,
      mereRoot: root,
    },
    logger: { info: () => {}, error: () => {} },
    signal: undefined,
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ spec, name, data });
      return Promise.resolve({ name });
    },
    createFileWriter: (spec: string, name: string) => ({
      writeText: (text: string) => {
        files.push(`${spec}/${name}:${text.length}`);
        return Promise.resolve({ name });
      },
    }),
  };
  return {
    base,
    root,
    checkout,
    context,
    written,
    files,
    env: home,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const previous = Deno.env.get("HOME");
      Deno.env.set("HOME", home);
      try {
        return await fn();
      } finally {
        if (previous === undefined) Deno.env.delete("HOME");
        else Deno.env.set("HOME", previous);
      }
    },
    cleanup: () => Deno.remove(base, { recursive: true }),
  };
}

const exec = (method: "validate" | "build" | "importOutputs") =>
  // deno-lint-ignore no-explicit-any
  (model.methods[method] as any).execute as (
    args: Record<string, unknown>,
    // deno-lint-ignore no-explicit-any
    context: any,
  ) => Promise<unknown>;

Deno.test("validate records the result and succeeds when mere accepts the recipe", async () => {
  const f = await fixture('echo "Recipe valid"; exit 0');
  try {
    await f.run(() =>
      exec("validate")(
        { recipe: "core/demo", checkoutPath: f.checkout },
        f.context,
      )
    );
    assertEquals(f.written.length, 1);
    assertEquals(f.written[0].spec, "validation-result");
    assertEquals(f.written[0].data.ok, true);
    assertEquals(f.written[0].data.success, true);
  } finally {
    await f.cleanup();
  }
});

Deno.test("validate records the rejection and then throws, so the step fails", async () => {
  const f = await fixture('echo "error: version is required" >&2; exit 1');
  try {
    await assertRejects(
      () =>
        f.run(() =>
          exec("validate")(
            { recipe: "core/demo", checkoutPath: f.checkout },
            f.context,
          )
        ),
      Error,
      "rejected core/demo: error: version is required",
    );
    assertEquals(f.written[0].data.ok, false);
    assertEquals(f.written[0].data.exitCode, 1);
  } finally {
    await f.cleanup();
  }
});

// The fake mere exports one package into <root>/mere/dev/outputs/<tuple>-<arch>.
const exportScript = (root: string, arch: string, name = "demo") =>
  `case "$*" in *build*) d="${root}/mere/dev/outputs/demo-1.0-1-${arch}"; mkdir -p "$d"; echo pkg > "$d/${name}-1.0-1-${arch}-${
    "c".repeat(64)
  }.pkg.tar.zst"; echo built;; esac; exit 0`;

Deno.test("build lists the packages whatever arch directory mere used", async () => {
  for (const arch of ["x86_64", "any", "unknown"]) {
    const f = await fixture("exit 0");
    try {
      await Deno.writeTextFile(
        join(f.base, "mere"),
        `#!/bin/sh\n${exportScript(f.root, arch)}\n`,
      );
      await f.run(() =>
        exec("build")({
          recipe: "core/demo",
          checkoutPath: f.checkout,
          noCache: true,
          timeoutMinutes: 5,
        }, f.context)
      );
      const record = f.written.find((w) => w.spec === "build-result")!.data;
      assertEquals(record.ok, true);
      assertEquals(record.arch, arch);
      assertEquals(record.name, "demo");
      const outputs = record.outputs as { package: string; sha256: string }[];
      assertEquals(outputs.length, 1);
      assertEquals(outputs[0].package, "demo");
      assertEquals(/^[0-9a-f]{64}$/.test(outputs[0].sha256), true);
    } finally {
      await f.cleanup();
    }
  }
});

Deno.test("build records the failing phase and error line, then throws", async () => {
  const f = await fixture(
    'echo "error prepare failed"; echo "error: blake3 mismatch" >&2; exit 2',
  );
  try {
    await assertRejects(
      () =>
        f.run(() =>
          exec("build")({
            recipe: "core/demo",
            checkoutPath: f.checkout,
            noCache: true,
            timeoutMinutes: 5,
          }, f.context)
        ),
      Error,
      "in prepare: error: blake3 mismatch",
    );
    const record = f.written.find((w) => w.spec === "build-result")!.data;
    assertEquals(record.ok, false);
    assertEquals(record.failingPhase, "prepare");
    assertEquals(record.errorLine, "error: blake3 mismatch");
    assertEquals(record.outputs, []);
  } finally {
    await f.cleanup();
  }
});

Deno.test("build treats a success that exported nothing as a failure", async () => {
  const f = await fixture("exit 0");
  try {
    await assertRejects(
      () =>
        f.run(() =>
          exec("build")({
            recipe: "core/demo",
            checkoutPath: f.checkout,
            noCache: false,
            timeoutMinutes: 5,
          }, f.context)
        ),
      Error,
      "produced no packages",
    );
    assertEquals(
      f.written.find((w) => w.spec === "build-result")!.data.ok,
      false,
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("build does not accept a stale export from an earlier run", async () => {
  const f = await fixture("exit 0");
  try {
    const stale = join(f.root, "mere", "dev", "outputs", "demo-1.0-1-x86_64");
    await Deno.mkdir(stale, { recursive: true });
    await Deno.writeTextFile(
      join(stale, `demo-1.0-1-x86_64-${"d".repeat(64)}.pkg.tar.zst`),
      "old",
    );
    await assertRejects(
      () =>
        f.run(() =>
          exec("build")({
            recipe: "core/demo",
            checkoutPath: f.checkout,
            noCache: true,
            timeoutMinutes: 5,
          }, f.context)
        ),
      Error,
      "produced no packages",
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("importOutputs records the result and throws when the import fails", async () => {
  const f = await fixture('echo "error: bad signature" >&2; exit 1');
  try {
    await assertRejects(
      () =>
        f.run(() => exec("importOutputs")({ repository: "local" }, f.context)),
      Error,
      "import failed for local: error: bad signature",
    );
    assertEquals(f.written[0].spec, "import-result");
    assertEquals(f.written[0].data.success, false);
  } finally {
    await f.cleanup();
  }
});

Deno.test("recipeFile requires an absolute checkout and builds the recipe path", () => {
  assertEquals(
    recipeFile("/work/tree", "core/zlib-ng"),
    "/work/tree/recipes/core/zlib-ng/recipe.kdl",
  );
  assertThrows(() => recipeFile("relative", "core/x"), Error, "absolute");
  assertEquals(firstLine("\n  \nfirst\nsecond"), "first");
});

Deno.test("recipe names must be <category>/<name>", () => {
  const schema = model.methods.build.arguments;
  assertEquals(
    schema.safeParse({ recipe: "../etc", checkoutPath: "/w" }).success,
    false,
  );
  assertEquals(
    schema.safeParse({ recipe: "core/zlib-ng", checkoutPath: "/w" }).success,
    true,
  );
});
