import { z } from "npm:zod@4.4.3";

const Text = z.string().trim().min(1).max(4000);

/** Maintainer-facing facts, never an execution transcript or status summary. */
export const MaintainerContextSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("change"),
    problem: Text.describe(
      "User-visible failure or missing capability; why the change is needed.",
    ),
    rationale: Text.describe(
      "Why this approach addresses the problem, including non-obvious design choices.",
    ),
    consequences: Text.optional().describe(
      "Relevant compatibility, behavior, or security boundaries; omit generic assurances.",
    ),
    verification: Text.optional().describe(
      "What a focused check demonstrates, not commands, totals, or pass/fail narration.",
    ),
  }).strict(),
  z.object({
    kind: z.literal("upstream"),
    summary: Text.describe(
      "Relevant upstream release context, verified changelog quotes, or release link.",
    ),
  }).strict(),
]);

export type MaintainerContext = z.infer<typeof MaintainerContextSchema>;

/** Optional workflow input; null is treated like an omitted context. */
export const OptionalMaintainerContextSchema = z.preprocess(
  (value) => value == null ? undefined : value,
  MaintainerContextSchema.optional(),
);

/**
 * Description modes are explicit because an empty body can be intentional:
 * releases use "none", self-describing changes use "optional", and only
 * changes that need explanation use "maintainer". "legacy" preserves the
 * pre-context packet behavior.
 */
export const DescriptionPolicySchema = z.enum([
  "legacy",
  "none",
  "optional",
  "maintainer",
]);
export type DescriptionPolicy = z.infer<typeof DescriptionPolicySchema>;

/** No model call and no invented rationale: render only facts the author supplied. */
export function renderMaintainerContext(raw: unknown): string {
  const context = MaintainerContextSchema.parse(raw);
  if (context.kind === "upstream") return context.summary;
  return [
    context.problem,
    context.rationale,
    context.consequences,
    context.verification,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
}

/** Bind reviewed context to the exact body carried in a signed change packet. */
export function checkDescriptionContext(
  body: string,
  context: unknown,
  policy: DescriptionPolicy = "legacy",
): string[] {
  const supplied = context == null ? undefined : context;
  if (policy === "none") {
    return [
      ...(body.trim() === "" ? [] : [
        "description policy 'none' requires an empty description",
      ]),
      ...(supplied === undefined ? [] : [
        "description policy 'none' does not accept maintainer context",
      ]),
    ];
  }
  if (supplied === undefined) {
    return policy === "maintainer"
      ? [
        "maintainer context is required: supply kind=change with problem and rationale, or kind=upstream with release context; put execution evidence in checks/reports",
      ]
      : [];
  }
  const parsed = MaintainerContextSchema.safeParse(supplied);
  if (!parsed.success) {
    return [
      "invalid maintainer context: " +
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(
        "; ",
      ),
    ];
  }
  return body === renderMaintainerContext(parsed.data) ? [] : [
    "the description does not match its maintainer context; regenerate it rather than appending execution commentary",
  ];
}
