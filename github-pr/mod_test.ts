import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { model } from "./mod.ts";

Deno.test("model exposes the stable PR contract", () => {
  assertEquals(model.type, "@jeremy/github-pr");
  assertEquals(model.version, "2026.11.15.1");
  assertEquals(Object.keys(model.resources).sort(), [
    "applied",
    "descriptionCheck",
    "plan",
    "preflight",
    "verification",
  ]);
  assertEquals(Object.keys(model.methods).sort(), [
    "applyPr",
    "checkDescription",
    "planPr",
    "preflight",
    "verifyPr",
  ]);
});

// The adapter must not acquire merge, release, or administration authority.
Deno.test("model exposes no merge, release, or administration method", () => {
  const forbidden = ["merge", "release", "admin", "delete", "update", "close"];
  const methods = Object.keys(model.methods).map((name) => name.toLowerCase());
  for (const word of forbidden) {
    assertEquals(
      methods.some((method) => method.includes(word)),
      false,
      `method surface must not include ${word}`,
    );
  }
});

Deno.test("checkDescription allows an empty body", async () => {
  const written: Array<{ spec: string; data: unknown }> = [];
  const ctx = {
    globalArgs: {},
    writeResource: (spec: string, _name: string, data: unknown) => {
      written.push({ spec, data });
      return Promise.resolve({ name: spec });
    },
  };
  await model.methods.checkDescription.execute(
    model.methods.checkDescription.arguments.parse({ body: "" }),
    ctx as never,
  );
  assertEquals((written[0].data as { ok: boolean }).ok, true);
});

Deno.test("checkDescription records and passes a body that meets the policy", async () => {
  const written: Array<{ spec: string; data: unknown }> = [];
  const ctx = {
    globalArgs: {},
    writeResource: (spec: string, _name: string, data: unknown) => {
      written.push({ spec, data });
      return Promise.resolve({ name: spec });
    },
  };
  await model.methods.checkDescription.execute(
    model.methods.checkDescription.arguments.parse({
      body: "One short paragraph.",
    }),
    ctx as never,
  );
  assertEquals(written[0].spec, "descriptionCheck");
  assertEquals((written[0].data as { ok: boolean }).ok, true);
});

Deno.test("checkDescription renders structured maintainer context", async () => {
  const written: Array<{ spec: string; data: unknown }> = [];
  const context = {
    kind: "change" as const,
    problem: "GPU discovery cannot see the device sysfs tree.",
    rationale: "Expose sysfs only in interactive shells with a read-only bind.",
  };
  await model.methods.checkDescription.execute(
    model.methods.checkDescription.arguments.parse({
      maintainerContext: context,
      policy: "maintainer",
    }),
    {
      globalArgs: {},
      writeResource: (spec: string, _name: string, data: unknown) => {
        written.push({ spec, data });
        return Promise.resolve({ name: spec });
      },
    } as never,
  );
  assertEquals(
    (written[0].data as { body: string }).body,
    "GPU discovery cannot see the device sysfs tree. Expose sysfs only in interactive shells with a read-only bind.",
  );
  assertEquals((written[0].data as { policy: string }).policy, "maintainer");
});

Deno.test("checkDescription permits intentional empty bodies in explicit modes", async () => {
  for (const policy of ["none", "optional"] as const) {
    const written: Array<{ spec: string; data: unknown }> = [];
    await model.methods.checkDescription.execute(
      model.methods.checkDescription.arguments.parse({
        body: "",
        policy,
      }),
      {
        globalArgs: {},
        writeResource: (spec: string, _name: string, data: unknown) => {
          written.push({ spec, data });
          return Promise.resolve({ name: spec });
        },
      } as never,
    );
    assertEquals((written[0].data as { ok: boolean }).ok, true, policy);
    assertEquals((written[0].data as { body: string }).body, "", policy);
  }
});

Deno.test("checkDescription accepts a concise optional summary without context", async () => {
  const written: Array<{ spec: string; data: unknown }> = [];
  await model.methods.checkDescription.execute(
    model.methods.checkDescription.arguments.parse({
      body: "Add the native package and its Vulkan runtime.",
      policy: "optional",
    }),
    {
      globalArgs: {},
      writeResource: (spec: string, _name: string, data: unknown) => {
        written.push({ spec, data });
        return Promise.resolve({ name: spec });
      },
    } as never,
  );
  assertEquals((written[0].data as { ok: boolean }).ok, true);
  assertEquals(
    (written[0].data as { body: string }).body,
    "Add the native package and its Vulkan runtime.",
  );
});

Deno.test("checkDescription rejects a nonempty none-policy body", async () => {
  await assertRejects(
    () =>
      model.methods.checkDescription.execute(
        model.methods.checkDescription.arguments.parse({
          body: "Unnecessary release commentary.",
          policy: "none",
        }),
        {
          globalArgs: {},
          writeResource: () => Promise.resolve({ name: "descriptionCheck" }),
        } as never,
      ),
    Error,
    "requires an empty description",
  );
});
Deno.test("checkDescription records every violation first and then throws", async () => {
  const written: Array<{ spec: string; data: unknown }> = [];
  const ctx = {
    globalArgs: {},
    writeResource: (spec: string, _name: string, data: unknown) => {
      written.push({ spec, data });
      return Promise.resolve({ name: spec });
    },
  };
  const body = "First.\n\n- a list";
  await assertRejects(
    () =>
      model.methods.checkDescription.execute(
        model.methods.checkDescription.arguments.parse({ body }),
        ctx as never,
      ),
    Error,
    "one paragraph",
  );
  assertEquals((written[0].data as { ok: boolean }).ok, false);
  // The same body is fine when a profile opts into markdown.
  await model.methods.checkDescription.execute(
    model.methods.checkDescription.arguments.parse({ body, style: "markdown" }),
    ctx as never,
  );
});
