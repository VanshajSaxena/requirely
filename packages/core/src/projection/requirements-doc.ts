import {
  emptyNotice,
  knownGaps,
  sourcesAppendix,
  unresolvedContradictions,
  whatWasAsked,
} from './appendices.ts';
import { withCitations } from './citations.ts';
import {
  byOrdinal,
  CONSTRAINT_CATEGORY,
  label,
  PRIORITY,
  REQUIREMENT_KIND,
  RISK,
} from './labels.ts';
import { blocks, entries, entry, lines, section } from './markdown.ts';
import type { Projection } from './types.ts';

/**
 * A product / requirements document.
 *
 * Same facts as the SRS, different reader. This one is for someone deciding
 * whether the understanding is *right* — a PM, a client, a designer — so it
 * groups by meaning rather than by IEEE section number, and it keeps
 * `whatWasAsked`: the record of which uncertainties were actually chased is
 * provenance for the *process*, which a reviewer wants and a builder does not.
 */
export const renderRequirementsDoc: Projection = (input) => {
  const understanding = input.revision.content;
  const { product } = understanding;
  const title = product.name ?? input.session.title ?? 'Untitled product';

  const resolvedContradictions = understanding.contradictions
    .filter((contradiction) => contradiction.resolution !== null)
    .sort(byOrdinal);

  return `${blocks([
    `# ${title}`,
    product.oneLiner === null ? '' : `*${product.oneLiner}*`,
    `> Understanding revision ${input.revision.revision}${
      input.session.status === 'exhausted'
        ? ' · the question budget ran out before every gap was closed'
        : ''
    }`,
    emptyNotice(understanding),

    section('The problem', product.problem ?? ''),
    section('What this is for', product.purpose ?? ''),

    section(
      'Who it serves',
      product.users.map((user) =>
        entry(user.label, user.description ?? 'No description captured.', [
          ...user.needs.map((need) => `needs: ${need}`),
        ]),
      ),
    ),

    section(
      'Requirements',
      entries(
        [...understanding.requirements]
          .sort(byOrdinal)
          .map((requirement) =>
            entry(
              label(requirement.id),
              withCitations(requirement.statement, requirement.provenance, input.sources),
              [
                `type: ${REQUIREMENT_KIND[requirement.kind]}${
                  requirement.priority === null ? '' : ` · ${PRIORITY[requirement.priority]}`
                }`,
                requirement.rationale === null ? '' : `why: ${requirement.rationale}`,
              ],
            ),
          ),
      ),
    ),

    section(
      'Constraints',
      entries(
        [...understanding.constraints]
          .sort(byOrdinal)
          .map((constraint) =>
            entry(
              label(constraint.id),
              withCitations(constraint.statement, constraint.provenance, input.sources),
              [`${CONSTRAINT_CATEGORY[constraint.category]}`],
            ),
          ),
      ),
    ),

    understanding.assumptions.length === 0
      ? ''
      : section(
          'Assumptions',
          blocks([
            'These were **not stated by anyone** — they were inferred to fill a hole. Each one is a decision someone should confirm.',
            lines(
              [...understanding.assumptions]
                .sort(byOrdinal)
                .map((assumption) =>
                  entry(
                    label(assumption.id),
                    withCitations(assumption.statement, assumption.provenance, input.sources),
                    [`basis: ${assumption.basis}`, `risk if wrong: ${RISK[assumption.risk]}`],
                  ),
                ),
            ),
          ]),
        ),

    section(
      'Contradictions that were settled',
      resolvedContradictions.map((contradiction) =>
        entry(label(contradiction.id), contradiction.description, [
          `resolved: ${contradiction.resolution ?? ''}`,
        ]),
      ),
    ),

    knownGaps(understanding),
    sourcesAppendix(input),
    unresolvedContradictions(understanding),
    whatWasAsked(understanding),
  ])}\n`;
};
