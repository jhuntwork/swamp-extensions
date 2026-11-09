const PROCESS_BOILERPLATE = [
  /\b(?:github actions|pipeline|ci)\b/i,
  /\b(?:validated|built) locally\b/i,
  /\btests?\s+(?:pass(?:ed)?|succeed(?:ed)?)\b/i,
  /\b(?:opened|created) by (?:automation|a bot|recipe-bump)\b/i,
  /\b(?:workflow|run)\s+(?:[0-9a-f]{8}-[0-9a-f-]{27,}|#?\d+)\b/i,
];

/** Return violations for the concise, maintainer-facing PR body contract. */
export function checkPullRequestDescription(body: string): string[] {
  const violations: string[] = [];
  const normalized = body.trim();
  if (normalized.length === 0) {
    violations.push("the description is empty");
    return violations;
  }
  if (normalized.length > 2_000) {
    violations.push("the description is longer than 2,000 characters");
  }
  if (/\n\s*\n/.test(normalized)) {
    violations.push("the description must be one paragraph");
  } else if (/\n/.test(normalized)) {
    violations.push("the description must not contain line breaks");
  }
  if (/^#{1,6}\s|^\s*(?:[-*+]\s|\d+[.)]\s)|```/m.test(normalized)) {
    violations.push(
      "the description must not contain headings, lists, or code fences",
    );
  }
  for (const pattern of PROCESS_BOILERPLATE) {
    if (pattern.test(normalized)) {
      violations.push(
        "the description must not contain pipeline, automation, or test-status boilerplate",
      );
      break;
    }
  }
  return violations;
}

/** Reject a PR body that does not meet the maintainer-facing contract. */
export function requirePullRequestDescription(body: string): void {
  const violations = checkPullRequestDescription(body);
  if (violations.length > 0) {
    throw new Error(`PR description policy: ${violations.join("; ")}`);
  }
}
