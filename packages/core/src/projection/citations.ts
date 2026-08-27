import type { Provenance, Source } from '../domain/index.ts';

/**
 * Renders provenance as `[src-1, src-3]`.
 *
 * **Quotes are deliberately not rendered.** `Provenance.quote` is never verified
 * against the source text (WEAKNESSES.md #1), and a specification is exactly
 * where a fabricated quotation would look most authoritative. A source reference
 * keeps full traceability — a reader can open `src-1` and check — without
 * printing verbatim text nothing has confirmed. When verification lands, quotes
 * switch on here and nowhere else.
 *
 * **A `sourceId` matching no supplied source is dropped**, not rendered and not
 * thrown on. Same asymmetry the engine already applies: an unknown reference in
 * a *delta* fails the turn, because a wrong understanding is worse than none;
 * an unknown reference while *rendering* costs one absent bracket, whereas
 * throwing costs the whole document.
 */
export function citations(provenance: readonly Provenance[], sources: readonly Source[]): string {
  const known = new Set(sources.map((source) => source.id as string));
  const cited = [...new Set(provenance.map((p) => p.sourceId as string))]
    .filter((id) => known.has(id))
    .sort();

  return cited.length === 0 ? '' : `[${cited.join(', ')}]`;
}

/** `statement [src-1]`, with no trailing space when there is nothing to cite. */
export const withCitations = (
  text: string,
  provenance: readonly Provenance[],
  sources: readonly Source[],
): string => {
  const rendered = citations(provenance, sources);
  return rendered === '' ? text : `${text} ${rendered}`;
};

/** How a source came to hold text — shown in the Sources appendix. */
export function describeSource(source: Source): string {
  const derived =
    source.derivedBy === 'transcription'
      ? 'transcribed'
      : source.derivedBy === 'extraction'
        ? 'text extracted'
        : null;
  const parts = [source.kind, derived].filter((part): part is string => part !== null);
  return `${source.origin.label} (${parts.join(', ')})`;
}
