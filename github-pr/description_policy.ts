const PROCESS_BOILERPLATE = [
  /\b(?:github actions|pipeline|ci)\s+(?:pass(?:ed)?|succeed(?:ed)?|is green|was green)\b/i,
  /\b(?:validated|built|tested) locally\b/i,
  /(?:^|[.!?:\n]\s*)(?:(?:all|the)\s+)?(?:\d+\s+)?tests?\s+(?:pass(?:ed)?|succeed(?:ed)?)\b/i,
  /\b(?:opened|created) by (?:automation|a bot|recipe-bump)\b/i,
  /\b(?:workflow run|run id)\s+(?:[0-9a-f]{8}-[0-9a-f-]{27,}|#?\d+)\b/i,
];

// Deliberately narrow canned operator assurances, not bans on security terms.
// For example, unchanged recipe-build isolation is relevant maintainer context.
const OPERATOR_ASSURANCES = [
  /\bno host installation(?: or kernel changes)?\s*(?:[.!?]|$)/i,
  /\b(?:host|host system)\s+(?:is|was|remains|left)\s+unchanged\b/i,
  /\b(?:nothing|no packages?)\s+(?:was |were )?installed (?:on|into) (?:the |your )?host\b/i,
];

export type DescriptionStyle = "paragraph" | "markdown";

/**
 * Return violations for the maintainer-facing PR body contract. The default
 * style is one short paragraph. The markdown style, which a delivery profile
 * opts into, also allows blank lines and lists, so quoted upstream notes stay
 * readable; headings and code fences are refused in both.
 */
export function checkPullRequestDescription(
  body: string,
  style: DescriptionStyle = "paragraph",
  allowEmpty = false,
): string[] {
  const violations: string[] = [];
  const normalized = body.trim();
  if (normalized.length === 0) {
    return violations;
  }
  const limit = style === "markdown" ? 4_000 : 2_000;
  if (normalized.length > limit) {
    violations.push(
      `the description is longer than ${
        limit.toLocaleString("en-US")
      } characters`,
    );
  }
  if (style === "paragraph") {
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
  } else if (/^\s{0,3}#{1,6}\s|```|~~~/m.test(normalized)) {
    violations.push("the description must not contain headings or code fences");
  }
  for (const pattern of PROCESS_BOILERPLATE) {
    if (pattern.test(normalized)) {
      violations.push(
        "the description must not contain pipeline, automation, or test-status boilerplate",
      );
      break;
    }
  }
  if (OPERATOR_ASSURANCES.some((pattern) => pattern.test(normalized))) {
    violations.push(
      "move operator reassurance about the host environment to execution reports; describe the relevant behavior or security boundary instead",
    );
  }
  return violations;
}

/** Reject a PR body that does not meet the maintainer-facing contract. */
export function requirePullRequestDescription(
  body: string,
  style: DescriptionStyle = "paragraph",
  allowEmpty = false,
): void {
  const violations = checkPullRequestDescription(body, style, allowEmpty);
  if (violations.length > 0) {
    throw new Error(`PR description policy: ${violations.join("; ")}`);
  }
}
