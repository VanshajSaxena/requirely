import {
  currentDecisions,
  type DecisionKind,
  openItems,
  type Understanding,
} from '../domain/index.ts';
import {
  emptyNotice,
  openItemsAppendix,
  sourcesAppendix,
  unresolvedContradictions,
  whyItStopped,
} from './appendices.ts';
import { withCitations } from './citations.ts';
import { byOrdinal, label } from './labels.ts';
import { blocks, entries, entry, group, section } from './markdown.ts';
import type { Projection, ProjectionInput } from './types.ts';

/**
 * A Software Requirements Specification.
 *
 * Section names and numbering follow IEEE 830 / ISO 29148, because "write me an
 * SRS" usually means "produce the document my reviewers recognise". Sections the
 * `Understanding` carries no data for — Definitions, References — are **omitted
 * rather than stubbed**: a first draft that is short is more useful than one
 * that is mostly "TBD", and `section()` drops an empty body automatically so no
 * renderer here writes a length check.
 *
 * **The body is built from `decisions`, not from the open collections.** That is
 * the redesign's whole claim made visible: a specification states what was
 * settled, and what was merely proposed belongs in Appendix A where a reader can
 * see it is not yet load-bearing. It has a consequence worth stating — an
 * early-stage session renders a thin document with a long appendix, and that is
 * the honest shape rather than a defect.
 */

const decisionsOfKind = (
  understanding: Understanding,
  input: ProjectionInput,
  kinds: readonly DecisionKind[],
): string[] =>
  currentDecisions(understanding)
    .filter((decision) => kinds.includes(decision.kind))
    .sort(byOrdinal)
    .map((decision) =>
      entry(
        label(decision.id),
        withCitations(decision.statement, decision.provenance, input.sources),
        [`rationale: ${decision.rationale}`],
      ),
    );

export const renderSrs: Projection = (input) => {
  const understanding = input.revision.content;
  const { product } = understanding;
  const title = product.name ?? input.session.title ?? 'Untitled product';

  return `${blocks([
    `# Software Requirements Specification — ${title}`,
    provenanceNote(input),
    emptyNotice(understanding),

    group('1. Introduction', [
      section('1.1 Purpose', product.purpose ?? '', { level: 3 }),
      section('1.2 Scope', product.oneLiner ?? '', { level: 3 }),
    ]),

    group('2. Overall description', [
      section('2.1 Product perspective', product.problem ?? '', { level: 3 }),
      section(
        '2.3 User characteristics',
        product.users.map((user) =>
          entry(
            user.label,
            user.description ?? 'No description captured.',
            user.needs.map((need) => `needs: ${need}`),
          ),
        ),
        { level: 3 },
      ),
      section('2.4 Constraints', entries(decisionsOfKind(understanding, input, ['constraint'])), {
        level: 3,
      }),
      section(
        '2.5 Assumptions and dependencies',
        entries(
          [...understanding.assumptions]
            .sort(byOrdinal)
            .map((assumption) =>
              entry(
                label(assumption.id),
                withCitations(assumption.statement, assumption.provenance, input.sources),
                [`basis: ${assumption.basis}`, `risk: ${assumption.risk}`],
              ),
            ),
        ),
        { level: 3 },
      ),
    ]),

    group('3. Specific requirements', [
      section(
        '3.1 Functional requirements',
        decisionsOfKind(understanding, input, ['functional', 'behavioural']),
        { level: 3 },
      ),
      section(
        '3.2 Non-functional requirements',
        decisionsOfKind(understanding, input, ['non-functional']),
        { level: 3 },
      ),
      section('3.3 Acceptance criteria', decisionsOfKind(understanding, input, ['acceptance']), {
        level: 3,
      }),
      section('3.4 Scope decisions', decisionsOfKind(understanding, input, ['scope']), {
        level: 3,
      }),
    ]),

    openItemsAppendix(understanding),
    sourcesAppendix(input),
    unresolvedContradictions(understanding),
  ])}\n`;
};

/**
 * Which revision produced this document, and how settled it is.
 *
 * Understanding is versioned and append-only, so a rendered document without its
 * revision number cannot be traced back to the state that produced it — and
 * "which version of the spec is this?" is the first question anyone asks of a
 * document that changed.
 *
 * The settled/open counts are here rather than in a section because they orient
 * the reader before the first heading: a body that looks thin is thin *because*
 * seven things are still open, and that number belongs above the fold.
 */
function provenanceNote(input: ProjectionInput): string {
  const understanding = input.revision.content;
  const settled = currentDecisions(understanding).length;
  const open = openItems(understanding).length;
  const status = whyItStopped(input.session.status);
  return `> Generated from understanding revision ${input.revision.revision} of session \`${input.session.id}\` — ${settled} decision${settled === 1 ? '' : 's'} settled, ${open} item${open === 1 ? '' : 's'} still open.${status}`;
}
