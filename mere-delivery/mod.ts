// deno-lint-ignore-file no-import-prefix
import { z } from "npm:zod@4.4.3";
import { checkCommit, parseRawCommit } from "./commit_policy.ts";
import { PROFILE_NAMES, PROFILES } from "./profiles.ts";

const CheckCommitArgs = z.object({
  profile: z.enum(PROFILE_NAMES).describe(
    "Which repository's commit and branch standards apply; see profiles.ts.",
  ),
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
  issue: z.number().int().min(0).default(0).describe(
    "Associated issue number, or 0 for none; when set, prBody must reference it.",
  ),
  prBody: z.string().optional(),
});

const CommitCheckSchema = z.object({
  profile: z.enum(PROFILE_NAMES),
  ok: z.boolean(),
  subject: z.string(),
  violations: z.array(z.string()),
  checkedExistingCommit: z.boolean(),
  schemaVersion: z.literal(1),
});

type Context = {
  logger?: {
    info: (message: string, fields?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

/** Check a commit message or an existing commit against a repository profile. */
export async function runCheck(
  args: z.infer<typeof CheckCommitArgs>,
  context: Context,
) {
  let message = args.message;
  let authorEmail: string | undefined;
  let existing = false;
  if (args.rawCommit) {
    const parsed = parseRawCommit(args.rawCommit);
    if (!parsed) {
      throw new Error("rawCommit is not '<name> <<email>>' then a message");
    }
    message = parsed.message;
    authorEmail = parsed.authorEmail;
    existing = true;
  }
  context.logger?.info("Checking commit against the {profile} profile", {
    profile: args.profile,
  });
  const violations = checkCommit(
    {
      message,
      title: args.title,
      branch: args.branch,
      authorEmail,
      issue: args.issue > 0 ? args.issue : undefined,
      prBody: args.prBody,
    },
    PROFILES[args.profile],
    {
      subject: args.expectedSubject,
      authorEmail: args.expectedAuthorEmail || undefined,
    },
  );
  const handle = await context.writeResource("commitCheck", "commit-check", {
    profile: args.profile,
    ok: violations.length === 0,
    subject: message.split("\n")[0] ?? "",
    violations,
    checkedExistingCommit: existing,
    schemaVersion: 1,
  });
  context.logger?.info("Commit check finished: {count} violation(s)", {
    count: violations.length,
  });
  if (violations.length > 0) {
    throw new Error(
      `commit standards (${args.profile}): ${violations.join("; ")}`,
    );
  }
  return { dataHandles: [handle] };
}

/** Commit and branch standards enforced as data, one profile per repository. */
export const model = {
  type: "@jeremy/mere-delivery",
  version: "2026.11.13.1",
  description:
    "Commit and branch standards for Mere repositories, enforced as data: profiles hold the rules, the check is deterministic.",
  globalArguments: z.object({}),
  upgrades: [{
    toVersion: "2026.11.13.1",
    description:
      "Replace @jeremy/mere/policy: rules come from named repository profiles, status claims are refused, and a referenced issue must appear in the PR body.",
    upgradeAttributes: (
      old: Record<string, unknown>,
    ): Record<string, unknown> => old,
  }],
  resources: {
    commitCheck: {
      description: "Result of checking a commit message against a profile",
      schema: CommitCheckSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    checkCommit: {
      description:
        "Check a commit message (before committing) or an existing commit (after) against a repository profile: subject length and pattern, body rules, trailers, status claims, PR title equal to subject, branch name, author, and a referenced issue. Records every violation, then throws if there are any.",
      kind: "read",
      arguments: CheckCommitArgs,
      execute: runCheck,
    },
  },
};
