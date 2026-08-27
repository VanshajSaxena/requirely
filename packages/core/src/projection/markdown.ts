/**
 * Markdown assembly, with one rule doing all the work.
 *
 * **A section whose body is empty renders nothing at all.** That is what makes
 * "standard headings, empty sections omitted" a property of the renderer rather
 * than a conditional repeated at twenty call sites — and it is why an SRS built
 * from a thin Understanding is short rather than a wall of "TBD".
 */

/** Drops empty entries and joins with a blank line between blocks. */
export const blocks = (parts: readonly (string | null | undefined | false)[]): string =>
  parts
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n\n');

export const lines = (parts: readonly (string | null | undefined | false)[]): string =>
  parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n');

/**
 * A heading plus body, or nothing.
 *
 * `body` may be an array; empty arrays and all-empty arrays vanish along with
 * their heading. Callers therefore never write `if (list.length > 0)`.
 */
export function section(
  heading: string,
  body: string | readonly (string | null | undefined | false)[],
  options: { level?: number } = {},
): string {
  const rendered = Array.isArray(body) ? joinItems(body) : typeof body === 'string' ? body : '';
  if (rendered.trim().length === 0) return '';
  return `${'#'.repeat(options.level ?? 2)} ${heading}\n\n${rendered}`;
}

/**
 * Joins a section's items the way Markdown needs them joined.
 *
 * Single-line items — bullets — are adjacent lines, because that is what makes
 * them one list. Multi-line items — `entry()` results — get a blank line
 * between them, because without it Markdown runs the second entry's label into
 * the first one's prose and the two become a single paragraph.
 *
 * Deciding this once here rather than at every call site is the difference
 * between a rule and a convention that one renderer eventually forgets.
 */
function joinItems(body: readonly (string | null | undefined | false)[]): string {
  const items = body.filter((part): part is string => typeof part === 'string' && part.length > 0);
  return items.some((item) => item.includes('\n')) ? blocks(items) : lines(items);
}

/**
 * A parent heading that appears only if at least one child section did.
 *
 * Without this, "2. Overall description" renders above nothing whenever the
 * Understanding happens to carry no users, constraints or assumptions. The
 * emptiness rule has to apply to whole branches, not just leaves — otherwise
 * every caller reimplements "should I print this heading?" and one of them gets
 * it wrong.
 */
export function group(
  heading: string,
  children: readonly string[],
  options: { level?: number } = {},
): string {
  const rendered = children.filter((child) => child.trim().length > 0);
  if (rendered.length === 0) return '';
  return blocks([`${'#'.repeat(options.level ?? 2)} ${heading}`, ...rendered]);
}

/**
 * Joins `entry()` results with a blank line between them.
 *
 * `lines()` is right for bullets — adjacent `- x` lines are one list. It is
 * wrong for entries, which span several lines each: run two together and
 * Markdown renders them as a single paragraph, so the second entry's label
 * disappears into the first one's prose.
 */
export const entries = (items: readonly string[]): string => blocks(items);

export const bullet = (text: string): string => `- ${text}`;

/**
 * A labelled entry: the id, the statement, then indented detail lines.
 *
 * Two spaces of indent rather than a nested list — these are continuations of
 * one entry, not children of it, and a nested list would render them as
 * separate points.
 */
export function entry(id: string, statement: string, detail: readonly string[] = []): string {
  const head = `**${id}** — ${statement}`;
  const rest = detail.filter((line) => line.trim().length > 0).map((line) => `  ${line}`);
  return lines([head, ...rest]);
}

/** Sentence-cases a fragment for prose, leaving already-capitalised text alone. */
export const sentence = (text: string): string =>
  text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`;
