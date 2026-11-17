import { assertEquals } from "jsr:@std/assert@1.0.19";

const WORKFLOWS = [
  "merelinux-change.yaml",
  "recipe-bump.yaml",
  "recipe-rebuild.yaml",
];

for (const workflow of WORKFLOWS) {
  Deno.test(`${workflow} derives the PR body from the commit message`, async () => {
    const text = await Deno.readTextFile(
      new URL(`./${workflow}`, import.meta.url),
    );
    const delivery = text.slice(
      text.indexOf('workflowIdOrName: "@jeremy/mere-delivery/deliver-change"'),
    );
    assertEquals(delivery.includes("commitMessage:"), true);
    assertEquals(delivery.includes("maintainerContext:"), false);
    assertEquals(delivery.includes("descriptionPolicy:"), false);
  });
}
