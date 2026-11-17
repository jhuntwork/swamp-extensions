export type DescriptionStyle = "paragraph" | "markdown";

/**
 * PR delivery supplies the exact commit body. The adapter does not rewrite it;
 * this hook remains for callers that need a description-check resource.
 */
export function checkPullRequestDescription(
  _body: string,
  _style: DescriptionStyle = "paragraph",
  _allowEmpty = true,
): string[] {
  return [];
}

/** The exact commit-body equality check belongs to the delivery policy. */
export function requirePullRequestDescription(
  _body: string,
  _style: DescriptionStyle = "paragraph",
  _allowEmpty = true,
): void {}
