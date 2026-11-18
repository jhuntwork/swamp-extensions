import { assertEquals } from "jsr:@std/assert@1.0.19";
import { parse } from "jsr:@std/yaml@1.0.12";

interface RecipeWorkflow {
  inputs: { properties: { recipePath: { pattern: string } } };
  jobs: {
    name: string;
    steps: { name: string; task: { inputs?: Record<string, string> } }[];
  }[];
}

async function recipeWorkflow(): Promise<RecipeWorkflow> {
  return parse(
    await Deno.readTextFile(
      new URL("./merelinux-change.yaml", import.meta.url),
    ),
  ) as RecipeWorkflow;
}

Deno.test("merelinux-change accepts recipe paths, not escaped dots or other files", async () => {
  const workflow = await recipeWorkflow();
  const pattern = new RegExp(workflow.inputs.properties.recipePath.pattern);
  for (
    const path of [
      "recipes/desktop/gmpopenh264/recipe.kdl",
      "recipes/core/zlib-ng/recipe.kdl",
    ]
  ) {
    assertEquals(pattern.test(path), true, path);
  }
  for (
    const path of [
      "recipes/desktop/gmpopenh264/recipeXkdl",
      "recipes/desktop/gmpopenh264/recipe\\.kdl",
      "recipes/desktop/gmpopenh264/recipe.kdl.bak",
      "recipes/desktop/gmpopenh264/nested/recipe.kdl",
      "desktop/gmpopenh264",
    ]
  ) {
    assertEquals(pattern.test(path), false, path);
  }
});

Deno.test("merelinux-change passes the checkout and recipe identifier separately", async () => {
  const workflow = await recipeWorkflow();
  const job = workflow.jobs.find((job) => job.name === "validate-and-deliver")!;
  const recipe =
    '${{ inputs.recipePath.split("/")[1] + "/" + inputs.recipePath.split("/")[2] }}';
  const expected: Record<string, Record<string, string>> = {
    "validate-recipe": { recipe, checkoutPath: "${{ inputs.worktreePath }}" },
    "build-recipe": {
      recipe,
      checkoutPath: "${{ inputs.worktreePath }}",
      timeoutMinutes: "${{ inputs.buildTimeoutMinutes }}",
    },
  };
  for (const [name, inputs] of Object.entries(expected)) {
    const step = job.steps.find((step) => step.name === name)!;
    assertEquals(step.task.inputs, inputs, name);
  }
});

const WORKFLOWS = [
  "merelinux-change.yaml",
  "recipe-bump.yaml",
  "recipe-rebuild.yaml",
];

// validate and build take recipe as <category>/<name> plus checkoutPath; a
// path-shaped recipe fails argument validation before mere runs.
for (const workflow of WORKFLOWS) {
  Deno.test(`${workflow} passes validate and build a checkoutPath`, async () => {
    const text = await Deno.readTextFile(
      new URL(`./${workflow}`, import.meta.url),
    );
    for (const method of ["validate", "build"]) {
      const at = text.indexOf(`methodName: ${method}\n`);
      if (at < 0) continue;
      const next = text.indexOf("\n      - name:", at);
      const block = text.slice(at, next < 0 ? undefined : next);
      assertEquals(
        block.includes("checkoutPath:"),
        true,
        `${method} in ${workflow}`,
      );
      assertEquals(
        block.includes('inputs.worktreePath + "/"'),
        false,
        `${method} in ${workflow}`,
      );
    }
  });
}

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
