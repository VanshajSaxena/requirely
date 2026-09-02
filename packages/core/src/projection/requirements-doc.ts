import { currentDecisions } from '../domain/index.ts';
import {
  emptyNotice,
  howDecisionsWereSettled,
  openItemsAppendix,
  sourcesAppendix,
  unresolvedContradictions,
  whyItStopped,
} from './appendices.ts';
import { withCitations } from './citations.ts';
import { byOrdinal, DECISION_KIND, label, RISK } from './labels.ts';
import { blocks, entries, entry, lines, section } from './markdown.ts';
import type { Projection } from './types.ts';

/**
 * A product / requirements document.
 *
 * Same facts as the SRS, different reader. This one is for someone deciding
 * whether the understanding is *right* — a PM, a client, a designer — so it
 * groups by meaning rather than by IEEE section number, and it keeps
 * `howDecisionsWereSettled`: the record of which uncertainties were actually
 * chased is provenance for the *process*, which a reviewer wants and a builder
 * does not.
 */
export const renderRequirementsDoc: Projection = (input) => {
  const understanding = input.revision.content;
  const { product } = understanding;
  const title = product.name ?? input.session.title ?? 'Untitled product';

  const decisions = currentDecisions(understanding).sort(byOrdinal);

  // A decision whose `promotedFrom` is a `ctr-` id is a conflict somebody
  // settled. Deriving it from the id prefix rather than storing a flag keeps the
  // lineage as the single source of truth — the same reason there is no `status`.
  const settledConflicts = decisions.filter((decision) =>
    decision.promotedFrom?.startsWith('ctr-'),
  );

  return `${blocks([
    `# ${title}`,
    product.oneLiner === null ? '' : `*${product.oneLiner}*`,
    `> Understanding revision ${input.revision.revision}${whyItStopped(input.session.status)}`,
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
      'What was decided',
      entries(
        decisions.map((decision) =>
          entry(
            label(decision.id),
            withCitations(decision.statement, decision.provenance, input.sources),
            [`type: ${DECISION_KIND[decision.kind]}`, `why: ${decision.rationale}`],
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
      settledConflicts.map((decision) =>
        entry(label(decision.id), decision.statement, [
          `was ${label(decision.promotedFrom ?? '')} — ${decision.rationale}`,
        ]),
      ),
    ),

    openItemsAppendix(understanding),
    sourcesAppendix(input),
    unresolvedContradictions(understanding),
    howDecisionsWereSettled(input),
  ])}\n`;
};
