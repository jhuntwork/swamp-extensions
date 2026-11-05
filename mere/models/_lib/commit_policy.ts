export interface CommitRules {
  maxSubjectLength: number;
  /** Regex the subject must match; empty means no pattern. */
  subjectPattern: string;
  allowBody: boolean;
  forbidTrailers: boolean;
  /** Regex the branch name must match; empty means no check. */
  branchPattern: string;
}

export const DEFAULT_RULES: CommitRules = {
  maxSubjectLength: 69,
  subjectPattern: "",
  allowBody: false,
  forbidTrailers: true,
  branchPattern: "",
};

export interface CommitUnderCheck {
  message: string;
  /** The pull request title; must equal the subject when given. */
  title?: string;
  branch?: string;
  authorEmail?: string;
}

export interface Expectations {
  /** The subject the commit was supposed to have (post-commit checks). */
  subject?: string;
  authorEmail?: string;
}

const TRAILER =
  /^(co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|cc|change-id)\s*:/i;

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
  if (rules.subjectPattern) {
    if (!new RegExp(rules.subjectPattern).test(subject)) {
      violations.push(`the subject does not match ${rules.subjectPattern}`);
    }
  }
  const rest = lines.slice(1);
  if (!rules.allowBody && rest.some((l) => l.trim() !== "")) {
    violations.push("the message has a body, and bodies are not allowed");
  }
  if (rules.allowBody && rest.length > 0 && rest[0].trim() !== "") {
    violations.push("the subject is not followed by a blank line");
  }
  if (rules.forbidTrailers && rest.some((l) => TRAILER.test(l))) {
    violations.push(
      "the message has a trailer (Co-authored-by, Signed-off-by, ...)",
    );
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
