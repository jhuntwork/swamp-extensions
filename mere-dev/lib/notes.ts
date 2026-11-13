/** One quoted line of an upstream changelog, labeled with the release it is from. */
export interface NoteEntry {
  version: string;
  quote: string;
}

/** Collapse every run of whitespace to one space, so wrapped lines compare equal. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Reasons a quote cannot go into a pull request body. A mention would notify
 * a stranger and an issue number would link an unrelated issue in this
 * repository; neither is something the upstream author meant here.
 */
export function unsafeInBody(quote: string): string | undefined {
  if (/```|~~~/.test(quote)) return "contains a code fence";
  if (/(^|[^\w`])@[A-Za-z0-9]/.test(quote)) {
    return "contains an @mention, which would notify that user";
  }
  if (/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+/i.test(quote)) {
    return "links a GitHub issue or pull request, which would cross-reference it";
  }
  // A URL fragment such as page#12 is not an issue reference.
  const text = quote.replace(/https?:\/\/\S+/g, " ");
  if (
    /(^|[^\w&/])#\d+/.test(text) || /[\w.-]+\/[\w.-]+#\d+/.test(text) ||
    /\bGH-\d+/i.test(text)
  ) {
    return "contains an issue reference, which would link an unrelated issue";
  }
  return undefined;
}

/**
 * Every problem that stops these entries from being recorded: a quote that is
 * not in the changelog, or one that is unsafe in a pull request body. The
 * match ignores whitespace and nothing else, so a reworded line fails.
 */
export function checkEntries(
  changelog: string,
  entries: NoteEntry[],
): string[] {
  const haystack = collapse(changelog);
  const problems: string[] = [];
  entries.forEach((entry, index) => {
    const quote = collapse(entry.quote);
    const where = `entry ${index + 1} (${entry.version})`;
    if (!haystack.includes(quote)) {
      problems.push(
        `${where} is not in the changelog: "${quote.slice(0, 80)}${
          quote.length > 80 ? "..." : ""
        }"`,
      );
      return;
    }
    const unsafe = unsafeInBody(quote);
    if (unsafe) problems.push(`${where} ${unsafe}`);
  });
  return problems;
}

/**
 * Markdown for the PR body: each release's label, then its quotes as bullets,
 * in the order given. Quotes are written exactly as the changelog has them,
 * with whitespace collapsed to a single line.
 */
export function renderEntries(entries: NoteEntry[]): string {
  const groups: { version: string; quotes: string[] }[] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    const quote = collapse(entry.quote);
    if (last && last.version === entry.version) last.quotes.push(quote);
    else groups.push({ version: entry.version, quotes: [quote] });
  }
  return groups
    .map((g) => `${g.version}:\n\n${g.quotes.map((q) => `- ${q}`).join("\n")}`)
    .join("\n\n");
}
