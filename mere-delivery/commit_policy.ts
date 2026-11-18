import { z } from "npm:zod@4.4.3";

/** Rules one repository's commits and branches must follow. */
export interface CommitRules {
  maxSubjectLength: number;
  /** Regex the subject must match; empty means no pattern. */
  subjectPattern: string;
  allowBody: boolean;
  /** Subjects matching this regex must have no body; empty means none. */
  noBodyPattern: string;
  forbidTrailers: boolean;
  /** Refuse status claims such as "tests pass" that a pipeline reports better. */
  forbidStatusClaims: boolean;
  /** Refuse conventional-commit type prefixes such as "fix:" or "feat(scope)!:". */
  forbidConventionalPrefix: boolean;
  /** Regex the branch name must match; empty means no check. */
  branchPattern: string;
}

export const IssueActionSchema = z.enum(["reference", "fixes"]);
export type IssueAction = z.infer<typeof IssueActionSchema>;

export interface CommitUnderCheck {
  message: string;
  /** The pull request title; must equal the subject when given. */
  title?: string;
  branch?: string;
  authorEmail?: string;
  /** An associated issue number; when given, the pull request body must cite it. */
  issue?: number;
  issueAction?: IssueAction;
  prBody?: string;
}

export interface Expectations {
  /** The subject the commit was supposed to have (post-commit checks). */
  subject?: string;
  authorEmail?: string;
}

const TRAILER =
  /^(co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|cc|change-id)\s*:/i;

/** A conventional-commit type, optional scope, and optional breaking marker. */
const CONVENTIONAL_PREFIX =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([^)]*\))?!?:/i;

/**
 * Claims that belong in the pipeline's results, not in a commit message. Each
 * pattern is narrow so that explaining why a test was added still passes.
 */
export const STATUS_CLAIMS: ReadonlyArray<{ label: string; pattern: RegExp }> =
  [
    {
      label: "a claim that tests pass",
      pattern:
        /\b(?:all\s+)?(?:(?:unit|integration|existing)\s+)?tests?\s+(?:now\s+|still\s+)?(?:pass(?:es|ed)?|succeed(?:s|ed)?|are\s+passing|are\s+green)\b/i,
    },
    {
      label: "a claim of local validation",
      pattern: /\b(?:validated|verified|built|tested)\s+locally\b/i,
    },
    {
      label: "a claim about CI or pipeline status",
      pattern:
        /\b(?:ci|pipeline|github\s+actions)\s+(?:pass(?:es|ed)?|is\s+green|succeed(?:s|ed)?)\b/i,
    },
    {
      label: "an AI-generation note",
      pattern:
        /\b(?:generated|written|authored|assisted)\s+(?:with|by)\s+(?:an?\s+)?(?:ai|claude|chatgpt|copilot|codex|kiro|gpt)\b|\u{1F916}/iu,
    },
  ];

/**
 * `git log --format='%an <%ae>%n%B'` output: the author line, then the full
 * message. Returns undefined when it does not look like that.
 */
export function parseRawCommit(
  raw: string,
): { authorName: string; authorEmail: string; message: string } | undefined {
  const newline = raw.indexOf("\n");
  if (newline < 0) return undefined;
  const match = /^(.*) <([^<>]*)>$/.exec(raw.slice(0, newline));
  if (!match) return undefined;
  return {
    authorName: match[1],
    authorEmail: match[2],
    message: raw.slice(newline + 1).replace(/\n+$/, ""),
  };
}

/** Return the body after the subject and its required blank-line separator. */
export function commitBody(message: string): string {
  const normalized = message.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const firstNewline = normalized.indexOf("\n");
  if (firstNewline < 0) return "";
  return normalized.slice(firstNewline + 1).replace(/^\n/, "");
}

function closingIssueNumbers(body: string): number[] {
  const numbers: number[] = [];
  const pattern = /\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+#(\d+)\b/gi;
  for (const match of body.matchAll(pattern)) {
    numbers.push(Number(match[1]));
  }
  return numbers;
}

export function preparePullRequestBody(
  body: string,
  issue: number,
  issueAction: IssueAction,
  message: string,
): string {
  const prepared = commitBody(message);
  if (
    message && body &&
    body.replace(/\r\n/g, "\n").replace(/\n+$/, "") !== prepared
  ) {
    throw new Error("the pull request body must exactly match the commit body");
  }
  if (issue <= 0) {
    if (issueAction === "fixes") {
      throw new Error("issueAction 'fixes' requires a positive issue number");
    }
    if (closingIssueNumbers(prepared).length > 0) {
      throw new Error(
        "issueAction 'reference' conflicts with a closing reference",
      );
    }
    return prepared;
  }
  const closing = closingIssueNumbers(prepared);
  if (issueAction === "fixes") {
    if (
      closing.length !== 1 || closing[0] !== issue ||
      !new RegExp(`\\bFixes\\s+#${issue}\\b`, "i").test(prepared)
    ) {
      throw new Error(
        `the commit body must contain only "Fixes #${issue}" as its closing reference`,
      );
    }
    return prepared;
  }
  if (closing.length > 0) {
    throw new Error(
      `issueAction 'reference' conflicts with a closing reference for #${issue}`,
    );
  }
  if (!new RegExp(`(?:^|[^\\w])#${issue}(?!\\d)`).test(prepared)) {
    throw new Error(`the commit body must reference issue #${issue}`);
  }
  return prepared;
}

/** Every way a commit breaks the rules; empty means it conforms. */
export function checkCommit(
  commit: CommitUnderCheck,
  rules: CommitRules,
  expect: Expectations = {},
): string[] {
  const violations: string[] = [];
  const message = commit.message.replace(/\r\n/g, "\n");
  const lines = message.replace(/\n+$/, "").split("\n");
  const subject = lines[0] ?? "";
  if (subject.trim() === "") violations.push("the subject is empty");
  if (subject !== subject.trim()) {
    violations.push("the subject has leading or trailing whitespace");
  }
  if (subject.length > rules.maxSubjectLength) {
    violations.push(
      `the subject is ${subject.length} characters; the limit is ${rules.maxSubjectLength}`,
    );
  }
  if (subject.endsWith(".")) violations.push("the subject ends with a period");
  if (rules.forbidConventionalPrefix && CONVENTIONAL_PREFIX.test(subject)) {
    violations.push(
      "the subject starts with a conventional-commit type prefix (fix:, feat:, ...); write the subject as a plain sentence",
    );
  }
  if (rules.subjectPattern) {
    if (!new RegExp(rules.subjectPattern).test(subject)) {
      violations.push(`the subject does not match ${rules.subjectPattern}`);
    }
  }
  const rest = lines.slice(1);
  const hasBody = rest.some((l) => l.trim() !== "");
  if (!rules.allowBody && hasBody) {
    violations.push("the message has a body, and bodies are not allowed");
  }
  if (
    rules.noBodyPattern && hasBody &&
    new RegExp(rules.noBodyPattern).test(subject)
  ) {
    violations.push(
      `a subject matching ${rules.noBodyPattern} must not have a body`,
    );
  }
  if (rules.allowBody && rest.length > 0 && rest[0].trim() !== "") {
    violations.push("the subject is not followed by a blank line");
  }
  if (rules.forbidTrailers && rest.some((l) => TRAILER.test(l))) {
    violations.push(
      "the message has a trailer (Co-authored-by, Signed-off-by, ...)",
    );
  }
  if (rules.forbidStatusClaims) {
    for (const claim of STATUS_CLAIMS) {
      if (claim.pattern.test(message)) {
        violations.push(
          `the message contains ${claim.label}; the pipeline reports that`,
        );
      }
    }
  }
  if (commit.prBody !== undefined) {
    const expectedBody = commitBody(message);
    const actualBody = commit.prBody.replace(/\r\n/g, "\n");
    if (actualBody !== expectedBody) {
      violations.push(
        "the pull request body must exactly match the commit body",
      );
    }
  }
  if (commit.title !== undefined && commit.title !== subject) {
    violations.push(
      `the pull request title "${commit.title}" differs from the subject "${subject}"`,
    );
  }
  if (commit.branch !== undefined && rules.branchPattern) {
    if (!new RegExp(rules.branchPattern).test(commit.branch)) {
      violations.push(
        `the branch "${commit.branch}" does not match ${rules.branchPattern}`,
      );
    }
  }
  const issueAction = commit.issueAction ?? "reference";
  const messageBody = commitBody(message);
  const closing = closingIssueNumbers(messageBody);
  if (issueAction === "reference" && closing.length > 0) {
    violations.push(
      "the commit body contains a closing reference; use issueAction 'fixes' to close an issue",
    );
  }
  if (issueAction === "fixes" && commit.issue === undefined) {
    violations.push("issueAction 'fixes' requires an issue number");
  }
  if (commit.issue !== undefined) {
    if (issueAction === "fixes") {
      if (
        closing.length !== 1 || closing[0] !== commit.issue ||
        !new RegExp(`\\bFixes\\s+#${commit.issue}\\b`, "i").test(messageBody)
      ) {
        violations.push(
          `the commit body must contain only "Fixes #${commit.issue}" as its closing reference`,
        );
      }
    } else {
      const cited = new RegExp(`(?:^|[^\\w])#${commit.issue}(?!\\d)`);
      if (!cited.test(messageBody)) {
        violations.push(
          `the commit body does not reference issue #${commit.issue}`,
        );
      }
    }
  }
  if (expect.subject !== undefined && expect.subject !== subject) {
    violations.push(
      `the commit subject is "${subject}", expected "${expect.subject}"`,
    );
  }
  if (
    expect.authorEmail && commit.authorEmail !== undefined &&
    commit.authorEmail !== expect.authorEmail
  ) {
    violations.push(
      `the author is ${commit.authorEmail}, expected ${expect.authorEmail}`,
    );
  }
  return violations;
}
