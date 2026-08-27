import type { Understanding } from '../domain/index.ts';
import { emptyNotice, knownGaps, sourcesAppendix, unresolvedContradictions } from './appendices.ts';
import { withCitations } from './citations.ts';
import { byOrdinal, CONSTRAINT_CATEGORY, label, PRIORITY } from './labels.ts';
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
 */

const requirementsOfKind = (
  understanding: Understanding,
  input: ProjectionInput,
  kinds: readonly string[],
): string[] =>
  [...understanding.requirements]
    .filter((requirement) => kinds.includes(requirement.kind))
    .sort(byOrdinal)
    .map((requirement) =>
      entry(
        label(requirement.id),
        withCitations(requirement.statement, requirement.provenance, input.sources),
        [
          requirement.priority === null ? '' : `priority: ${PRIORITY[requirement.priority]}`,
          requirement.rationale === null ? '' : `rationale: ${requirement.rationale}`,
        ],
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
      section(
        '2.4 Constraints',
        entries(
          [...understanding.constraints]
            .sort(byOrdinal)
            .map((constraint) =>
              entry(
                label(constraint.id),
                withCitations(constraint.statement, constraint.provenance, input.sources),
                [`category: ${CONSTRAINT_CATEGORY[constraint.category]}`],
              ),
            ),
        ),
        { level: 3 },
      ),
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
        requirementsOfKind(understanding, input, ['functional', 'behavioural']),
        { level: 3 },
      ),
      section(
        '3.2 Non-functional requirements',
        requirementsOfKind(understanding, input, ['non-functional']),
        { level: 3 },
      ),
      section('3.3 Acceptance criteria', requirementsOfKind(understanding, input, ['acceptance']), {
        level: 3,
      }),
    ]),

    knownGaps(understanding),
    sourcesAppendix(input),
    unresolvedContradictions(understanding),
  ])}\n`;
};

/**
 * Which revision produced this document.
 *
 * Understanding is versioned and append-only, so a rendered document without its
 * revision number cannot be traced back to the state that produced it — and
 * "which version of the spec is this?" is the first question anyone asks of a
 * document that changed.
 */
function provenanceNote(input: ProjectionInput): string {
  const status =
    input.session.status === 'exhausted'
      ? ' The question budget was exhausted before every gap was closed.'
      : '';
  return `> Generated from understanding revision ${input.revision.revision} of session \`${input.session.id}\`.${status}`;
}
