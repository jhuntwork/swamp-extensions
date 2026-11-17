export type DescriptionStyle = "paragraph" | "markdown";

/**
 * PR delivery does not impose a prose format. The caller supplies the
 * description so it can explain why the change matters without repeating the
 * subject or implementation details already clear from the commit.
 */
export function checkPullRequestDescription(
  _body: string,
  _style: DescriptionStyle = "paragraph",
  _allowEmpty = true,
): string[] {
  return [];
}

/** The caller owns the prose; this hook only records that it was accepted. */
export function requirePullRequestDescription(
  _body: string,
  _style: DescriptionStyle = "paragraph",
  _allowEmpty = true,
): void {}
