import { currentDecisions, type OpenItem, openItems, type Understanding } from '../domain/index.ts';
import { describeSource } from './citations.ts';
import { byOrdinal, DIMENSION, label } from './labels.ts';
import { blocks, entries, entry, lines, section } from './markdown.ts';
import type { ProjectionInput } from './types.ts';

/**
 * The parts every projection shares.
 *
 * They are identical across all three targets by decision, so they live here
 * once. Three renderers each growing their own "what we still don't know"
 * section is three places for the honesty to quietly diverge.
 */

/** The one human-readable line an open item has, whichever collection it came from. */
const statementOf = (item: OpenItem): string =>
  'statement' in item ? item.statement : item.description;

/**
 * What this specification has not settled.
 *
 * Rendered **whenever anything is still open**, not only when the session ran
 * out of questions. `sufficient` means every *required* coverage dimension
 * cleared the policy bar — items in non-required dimensions can still be open,
 * and hiding them would make the most confident-looking document the least
 * honest one.
 *
 * This replaced "Known gaps", and the difference is more than a rename. A gap
 * was a claim that something was missing; an open item is the thing itself,
 * unsettled. So this appendix now shows the reader *what was proposed and never
 * confirmed* rather than a list of topics nobody wrote about.
 */
export function openItemsAppendix(understanding: Understanding): string {
  // Contradictions get their own appendix — listing them twice would make the
  // count in the preamble below disagree with what the reader can see.
  const open = openItems(understanding)
    .filter((item) => !('between' in item))
    .sort(byOrdinal);
  if (open.length === 0) return '';

  const blocking = open.filter((item) => item.blocking).length;
  const preamble =
    blocking === 0
      ? 'This specification is complete enough to build from, with the following still unsettled.'
      : blocking === open.length
        ? `This specification is incomplete. ${blocking === 1 ? 'The item' : `All ${blocking} items`} below ${blocking === 1 ? 'was' : 'were'} judged blocking — ${blocking === 1 ? 'it' : 'they'} should be settled before anyone builds from this.`
        : `This specification is incomplete. ${blocking} of the ${open.length} items below ${blocking === 1 ? 'was' : 'were'} judged blocking and should be settled before anyone builds from this.`;

  return section(
    'Appendix A — Still open',
    blocks([
      preamble,
      entries(
        open.map((item) =>
          entry(
            label(item.id),
            DIMENSION[item.dimension],
            [statementOf(item), item.blocking ? '**blocking**' : ''].filter(
              (line) => line.length > 0,
            ),
          ),
        ),
      ),
    ]),
  );
}

/**
 * Conflicts nobody settled.
 *
 * Every contradiction still in the collection is by definition unresolved: there
 * is no `resolution` field any more, because resolving a contradiction *is*
 * promoting it to a Decision. A settled one has therefore already left this
 * array and appears among the decisions instead.
 */
export function unresolvedContradictions(understanding: Understanding): string {
  const open = [...understanding.contradictions].sort(byOrdinal);
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
 * What was decided, and what settled it.
 *
 * The requirements document only. This is provenance for the *process* rather
 * than for the product: a reviewer deciding whether to trust the spec wants to
 * see which uncertainties were actually chased, and an SRS handed to a builder
 * does not.
 *
 * **Known limitation, and it is the same one Phase 6 recorded.** `settledBy`
 * names an Answer, but Answers and Questions live in the inquiry repository and
 * `ProjectionInput` does not carry them — so this renders the id rather than the
 * question that was asked. Widening `ProjectionInput` to carry `{ questions,
 * answers }` is Step 5, and it is what unlocks the MADR-style "we chose SSO; we
 * considered and rejected magic links because …" that this appendix wants to be.
 */
export function howDecisionsWereSettled(understanding: Understanding): string {
  const decided = currentDecisions(understanding).sort(byOrdinal);
  if (decided.length === 0) return '';

  return section(
    'Appendix D — What was decided, and what settled it',
    entries(
      decided.map((decision) =>
        entry(label(decision.id), DIMENSION[decision.dimension], [
          decision.statement,
          `because: ${decision.rationale}`,
          `settled by: ${decision.settledBy}${decision.promotedFrom === null ? '' : ` (previously ${label(decision.promotedFrom)})`}`,
        ]),
      ),
    ),
  );
}

/**
 * Says plainly when there is nothing to render.
 *
 * An empty Understanding produces a document that admits it rather than a
 * heading with silence underneath — the same principle as the open-items
 * appendix.
 */
export function emptyNotice(understanding: Understanding): string {
  const nothing = understanding.decisions.length === 0 && openItems(understanding).length === 0;
  if (!nothing) return '';

  return lines([
    '> **Nothing has been captured yet.**',
    '>',
    '> No decisions, requirements, constraints or assumptions were derived from',
    '> the input provided. This document is a placeholder, not a specification.',
  ]);
}
