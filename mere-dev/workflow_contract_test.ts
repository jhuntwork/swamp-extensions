import { assertEquals } from "jsr:@std/assert@1.0.19";

const WORKFLOWS = [
  "merelinux-change.yaml",
  "recipe-bump.yaml",
  "recipe-rebuild.yaml",
];

for (const workflow of WORKFLOWS) {
  Deno.test(`${workflow} carries maintainer context to shared delivery`, async () => {
    const text = await Deno.readTextFile(
      new URL(`./${workflow}`, import.meta.url),
    );
    assertEquals(
      text.includes('workflowIdOrName: "@jeremy/mere-delivery/deliver-change"'),
      true,
    );
    assertEquals(text.includes("maintainerContext:"), true);
    assertEquals(
      text.indexOf(
        "maintainerContext:",
        text.indexOf(
          'workflowIdOrName: "@jeremy/mere-delivery/deliver-change"',
        ),
      ) >= 0,
      true,
    );
  });
}
