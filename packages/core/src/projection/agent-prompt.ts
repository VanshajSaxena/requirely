import { currentDecisions, type OpenItem, openItems } from '../domain/index.ts';
import { deliberations } from './deliberation.ts';
import { byOrdinal, DECISION_KIND, DIMENSION, label, RISK } from './labels.ts';
import { blocks, bullet, lines, section } from './markdown.ts';
import type { Projection } from './types.ts';

/**
 * A prompt for an AI coding agent.
 *
 * Written for a different reader than the other two, and the difference is not
 * cosmetic. A human reviewer skims and forms judgement; an agent reads and
 * *acts*. So this projection:
 *
 * - drops citations. `[src-1]` is traceability for someone who can open the
 *   source. An agent cannot, and the bracket is only tokens it has to skip.
 * - states assumptions as **decisions made on its behalf**, not as background.
 *   An assumption the agent does not know was an assumption is a requirement it
 *   will defend rather than question.
 * - renders **everything still open** as an instruction to stop and ask. This is
 *   the whole thesis of the product turned on its own output: an agent guessing
 *   at an unstated requirement is precisely the failure Requirely exists to
 *   prevent, and it would be absurd to hand one an under-specified brief.
 *
 * The settled/open split does more work for this reader than for either human
 * one. A `Decision` is something to implement; an open item is something to ask
 * about. Handing an agent both under one heading is how a proposal gets built.
 *
 * **It also gets the rejected alternatives, which the human documents render as
 * process provenance and this one renders as a constraint.** That is a deliberate
 * departure from "drop anything an agent cannot act on": a rejected option is
 * precisely actionable — it is the solution space closing. An agent that
 * proposes magic links after the team rejected them costs a review cycle to
 * rediscover something already written down, which is the exact waste this
 * product exists to prevent, aimed at its own output.
 */
export const renderAgentPrompt: Projection = (input) => {
  const understanding = input.revision.content;
  const { product } = understanding;
  const name = product.name ?? input.session.title ?? 'this product';

  const decisions = currentDecisions(understanding).sort(byOrdinal);
  // Contradictions are pulled out separately because they need different wording
  // — "the sources disagree" is a distinct instruction from "nobody said".
  const open = openItems(understanding)
    .filter((item) => !('between' in item))
    .sort(byOrdinal);
  const unresolved = [...understanding.contradictions].sort(byOrdinal);
  const nothingOutstanding = open.length === 0 && unresolved.length === 0;

  const statementOf = (item: OpenItem): string =>
    'statement' in item ? item.statement : item.description;

  // Only options that were offered and not taken. Compact on purpose — the
  // agent needs the shape of the door that is closed, not the deliberation.
  const trail = deliberations(input);
  const rejected = decisions.flatMap((decision) =>
    (trail.get(decision.id)?.rejected ?? []).map((option) => `${option.label} — ${option.means}`),
  );

  return `${blocks([
    `You are implementing **${name}**.`,
    lines([
      'The requirements below were gathered from the stakeholder and are the',
      'authoritative description of what to build. Read all of it, including the',
      'final section, before writing any code.',
    ]),

    section(
      'What you are building',
      lines([
        product.oneLiner ?? '',
        product.purpose === null ? '' : `\n${product.purpose}`,
        product.problem === null ? '' : `\nThe problem it solves: ${product.problem}`,
      ]),
    ),

    section(
      'Who uses it',
      product.users.map((user) =>
        bullet(
          `**${user.label}** — ${user.description ?? 'no description captured'}${
            user.needs.length === 0 ? '' : ` (needs: ${user.needs.join('; ')})`
          }`,
        ),
      ),
    ),

    section(
      'What was decided — build exactly this',
      decisions
        .filter((decision) => decision.kind !== 'constraint')
        .map((decision) =>
          bullet(
            `${label(decision.id)} — ${decision.statement} _(${DECISION_KIND[decision.kind]}; ${decision.rationale})_`,
          ),
        ),
    ),

    section(
      'Constraints you must respect',
      decisions
        .filter((decision) => decision.kind === 'constraint')
        .map((decision) => bullet(`${label(decision.id)} — ${decision.statement}`)),
    ),

    understanding.assumptions.length === 0
      ? ''
      : section(
          'Assumptions made on your behalf',
          blocks([
            'Nobody stated these. They were inferred to fill a hole, and each is a decision you are inheriting rather than a fact you can rely on. If one turns out to matter, raise it.',
            lines(
              [...understanding.assumptions]
                .sort(byOrdinal)
                .map((assumption) =>
                  bullet(
                    `${label(assumption.id)} — ${assumption.statement} _(basis: ${assumption.basis}; risk if wrong: ${RISK[assumption.risk]})_`,
                  ),
                ),
            ),
          ]),
        ),

    // The section that makes this a prompt rather than a document.
    section(
      'STOP — ask about these before implementing',
      nothingOutstanding
        ? ''
        : blocks([
            lines([
              'The following were never settled. **Do not guess and do not pick a',
              'sensible default.** Ask, get an answer, then proceed — an implementation',
              'built on an invented requirement costs more to undo than to delay.',
            ]),
            lines([
              ...open.map((item) =>
                bullet(
                  `**${DIMENSION[item.dimension]}**: ${statementOf(item)}${
                    item.blocking ? ' _(blocking)_' : ''
                  }`,
                ),
              ),
              ...unresolved.map((contradiction) =>
                bullet(
                  `**conflicting information**: ${contradiction.description} — nobody resolved this`,
                ),
              ),
            ]),
          ]),
    ),

    section(
      'Already considered and rejected',
      rejected.length === 0
        ? ''
        : blocks([
            'These were on the table and were not chosen. Do not propose them again; if one now looks unavoidable, say so and explain what changed rather than quietly adopting it.',
            lines(rejected.map((option) => bullet(option))),
          ]),
    ),

    nothingOutstanding
      ? section(
          'Nothing is outstanding',
          'Everything raised during gathering was settled. If you find yourself needing to invent a requirement, that is something the gathering missed — raise it rather than filling it in.',
        )
      : '',
  ])}\n`;
};
