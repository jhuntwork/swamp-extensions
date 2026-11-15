import { assertEquals } from "jsr:@std/assert@1.0.19";
import { model } from "./mod.ts";

Deno.test("model exposes the stable PR contract", () => {
  assertEquals(model.type, "@jeremy/github-pr");
  assertEquals(model.version, "2026.11.15.2");
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

Deno.test("checkDescription accepts the commit body's formatting unchanged", async () => {
  const written: Array<{ spec: string; data: unknown }> = [];
  const ctx = {
    globalArgs: {},
    writeResource: (spec: string, _name: string, data: unknown) => {
      written.push({ spec, data });
      return Promise.resolve({ name: spec });
    },
  };
  const body = "# Heading\n\n- a list\n\nTests pass.";
  await model.methods.checkDescription.execute(
    model.methods.checkDescription.arguments.parse({ body }),
    ctx as never,
  );
  assertEquals((written[0].data as { ok: boolean }).ok, true);
});
