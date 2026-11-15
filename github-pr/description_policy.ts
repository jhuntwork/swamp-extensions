export type DescriptionStyle = "paragraph" | "markdown";

/**
 * PR delivery does not impose a prose format. The delivery contract compares
 * the PR body with the commit body exactly; this hook remains for callers that
 * need a description-check resource.
 */
export function checkPullRequestDescription(
  _body: string,
  _style: DescriptionStyle = "paragraph",
  _allowEmpty = true,
): string[] {
  return [];
}

/** The commit-body equality check belongs to the delivery policy, not here. */
export function requirePullRequestDescription(
  _body: string,
  _style: DescriptionStyle = "paragraph",
  _allowEmpty = true,
): void {}
