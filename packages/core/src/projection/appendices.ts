import type { Understanding } from '../domain/index.ts';
import { describeSource } from './citations.ts';
import { byOrdinal, DIMENSION, label, RISK } from './labels.ts';
import { blocks, entries, entry, lines, section } from './markdown.ts';
import type { ProjectionInput } from './types.ts';

/**
 * The parts every projection shares.
 *
 * They are identical across all three targets by decision, so they live here
 * once. Three renderers each growing their own "known gaps" section is three
 * places for the honesty to quietly diverge.
 */

/**
 * What this specification does not know.
 *
 * Rendered **whenever gaps are open**, not only when the session ran out of
 * questions. `sufficient` means every *required* coverage dimension cleared the
 * policy bar — gaps in non-required dimensions can still be open, and hiding
 * them would make the most confident-looking document the least honest one.
 */
export function knownGaps(understanding: Understanding): string {
  const open = [...understanding.gaps].sort(byOrdinal);
  if (open.length === 0) return '';

  const blocking = open.filter((gap) => gap.blocking).length;
  const preamble =
    blocking === 0
      ? 'This specification is complete enough to build from, with the following still unresolved.'
      : blocking === open.length
        ? `This specification is incomplete. ${blocking === 1 ? 'The question' : `All ${blocking} questions`} below ${blocking === 1 ? 'was' : 'were'} judged blocking — ${blocking === 1 ? 'it' : 'they'} should be answered before anyone builds from this.`
        : `This specification is incomplete. ${blocking} of the ${open.length} questions below ${blocking === 1 ? 'was' : 'were'} judged blocking and should be answered before anyone builds from this.`;

  return section(
    'Appendix A — Known gaps',
    blocks([
      preamble,
      entries(
        open.map((gap) =>
          entry(label(gap.id), `${DIMENSION[gap.dimension]} / ${gap.topic}`, [
            gap.description,
            `impact: ${RISK[gap.impact]}${gap.blocking ? ' · **blocking**' : ''}`,
          ]),
        ),
      ),
    ]),
  );
}

/**
 * Conflicts nobody settled.
 *
 * Only *unresolved* ones (`resolution === null`) appear here — a contradiction
 * that was resolved is rendered inline with its resolution, because at that
 * point it is a decision rather than a problem.
 */
export function unresolvedContradictions(understanding: Understanding): string {
  const open = understanding.contradictions
    .filter((contradiction) => contradiction.resolution === null)
    .sort(byOrdinal);
  if (open.length === 0) return '';

  return section(
    'Appendix C — Unresolved contradictions',
    blocks([
      'The sources disagree on the following, and the disagreement was never settled.',
      entries(
        open.map((contradiction) =>
          entry(label(contradiction.id), contradiction.description, [
            `sources: ${contradiction.between.map((p) => p.sourceId).join(', ')}`,
          ]),
        ),
      ),
    ]),
  );
}

/** Where the content came from. Cited inline as `[src-1]`; named here. */
export function sourcesAppendix(input: ProjectionInput): string {
  if (input.sources.length === 0) return '';

  return section(
    'Appendix B — Sources',
    blocks([
      'Everything above was derived from these inputs.',
      lines(
        [...input.sources]
          .sort(byOrdinal)
          .map((source) => `- **${source.id}** — ${describeSource(source)}`),
      ),
    ]),
  );
}

/**
 * What was asked and what it settled.
 *
 * The requirements document only. This is provenance for the *process* rather
 * than for the product: a reviewer deciding whether to trust the spec wants to
 * see which uncertainties were actually chased, and an SRS handed to a builder
 * does not.
 */
export function whatWasAsked(understanding: Understanding): string {
  const resolved = [...understanding.resolvedGaps].sort(byOrdinal);
  if (resolved.length === 0) return '';

  return section(
    'Appendix D — What was asked, and what it settled',
    entries(
      resolved.map((gap) =>
        entry(label(gap.id), `${DIMENSION[gap.dimension]} / ${gap.topic}`, [
          `learned: ${gap.resolution}`,
        ]),
      ),
    ),
  );
}

/**
 * Says plainly when there is nothing to render.
 *
 * An empty Understanding produces a document that admits it rather than a
 * heading with silence underneath — the same principle as the gaps appendix.
 */
export function emptyNotice(understanding: Understanding): string {
  const nothing =
    understanding.requirements.length === 0 &&
    understanding.constraints.length === 0 &&
    understanding.assumptions.length === 0;
  if (!nothing) return '';

  return lines([
    '> **Nothing has been captured yet.**',
    '>',
    '> No requirements, constraints or assumptions were derived from the input',
    '> provided. This document is a placeholder, not a specification.',
  ]);
}
