import { z } from "npm:zod@4.1.12";
import {
  checkCommit,
  DEFAULT_RULES,
  parseRawCommit,
} from "./_lib/commit_policy.ts";

const CheckCommitArgs = z.object({
  message: z.string().default("").describe(
    "The commit message to check; or give rawCommit.",
  ),
  rawCommit: z.string().default("").describe(
    "`git log -1 --format='%an <%ae>%n%B'` output, to check a commit that exists.",
  ),
  title: z.string().optional().describe(
    "The PR title; must equal the subject.",
  ),
  branch: z.string().optional(),
  expectedSubject: z.string().optional(),
  expectedAuthorEmail: z.string().default(""),
  maxSubjectLength: z.number().int().min(10).default(
    DEFAULT_RULES.maxSubjectLength,
  ),
  subjectPattern: z.string().default(DEFAULT_RULES.subjectPattern),
  allowBody: z.boolean().default(DEFAULT_RULES.allowBody),
  forbidTrailers: z.boolean().default(DEFAULT_RULES.forbidTrailers),
  branchPattern: z.string().default(DEFAULT_RULES.branchPattern),
});

const CommitCheckSchema = z.object({
  ok: z.boolean(),
  subject: z.string(),
  violations: z.array(z.string()),
  checkedExistingCommit: z.boolean(),
  schemaVersion: z.literal(1),
});

export const behavior = {
  type: "@jeremy/mere/policy",
  version: "2026.11.05.1",
  description:
    "Commit and branch standards, enforced as data: the rules are inputs, the check is deterministic.",
  globalArguments: z.object({}),
  resources: {
    commitCheck: {
      description: "Result of checking a commit message against the rules",
      schema: CommitCheckSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    checkCommit: {
      description:
        "Check a commit message (before committing) or an existing commit (after) " +
        "against the rules: subject length and pattern, no body, no trailers, " +
        "title equals subject, branch name, and the expected author. Records " +
        "every violation, then throws if there are any.",
      kind: "read",
      arguments: CheckCommitArgs,
      execute: async (
        args: z.infer<typeof CheckCommitArgs>,
        context: {
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        let message = args.message;
        let authorEmail: string | undefined;
        let existing = false;
        if (args.rawCommit) {
          const parsed = parseRawCommit(args.rawCommit);
          if (!parsed) {
            throw new Error(
              "rawCommit is not '<name> <<email>>' then a message",
            );
          }
          message = parsed.message;
          authorEmail = parsed.authorEmail;
          existing = true;
        }
        const violations = checkCommit(
          { message, title: args.title, branch: args.branch, authorEmail },
          {
            maxSubjectLength: args.maxSubjectLength,
            subjectPattern: args.subjectPattern,
            allowBody: args.allowBody,
            forbidTrailers: args.forbidTrailers,
            branchPattern: args.branchPattern,
          },
          {
            subject: args.expectedSubject,
            authorEmail: args.expectedAuthorEmail || undefined,
          },
        );
        const handle = await context.writeResource(
          "commitCheck",
          "commit-check",
          {
            ok: violations.length === 0,
            subject: message.split("\n")[0] ?? "",
            violations,
            checkedExistingCommit: existing,
            schemaVersion: 1,
          },
        );
        if (violations.length > 0) {
          throw new Error(`commit standards: ${violations.join("; ")}`);
        }
        return { dataHandles: [handle] };
      },
    },
  },
};
