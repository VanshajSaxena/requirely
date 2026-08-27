import { byOrdinal, CONSTRAINT_CATEGORY, DIMENSION, label, RISK } from './labels.ts';
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
 * - renders open gaps as an **instruction to stop and ask**. This is the whole
 *   thesis of the product turned on its own output: an agent guessing at an
 *   unstated requirement is precisely the failure Requirely exists to prevent,
 *   and it would be absurd to hand one an under-specified brief.
 */
export const renderAgentPrompt: Projection = (input) => {
  const understanding = input.revision.content;
  const { product } = understanding;
  const name = product.name ?? input.session.title ?? 'this product';

  const openGaps = [...understanding.gaps].sort(byOrdinal);
  const unresolved = understanding.contradictions
    .filter((contradiction) => contradiction.resolution === null)
    .sort(byOrdinal);

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
      'Requirements',
      [...understanding.requirements]
        .sort(byOrdinal)
        .map((requirement) =>
          bullet(
            `${label(requirement.id)} — ${requirement.statement}${
              requirement.rationale === null ? '' : ` _(${requirement.rationale})_`
            }`,
          ),
        ),
    ),

    section(
      'Constraints you must respect',
      [...understanding.constraints]
        .sort(byOrdinal)
        .map((constraint) =>
          bullet(
            `${label(constraint.id)} — ${constraint.statement} _(${CONSTRAINT_CATEGORY[constraint.category]})_`,
          ),
        ),
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
      openGaps.length === 0 && unresolved.length === 0
        ? ''
        : blocks([
            lines([
              'The following are genuinely unknown. **Do not guess and do not pick a',
              'sensible default.** Ask, get an answer, then proceed — an implementation',
              'built on an invented requirement costs more to undo than to delay.',
            ]),
            lines([
              ...openGaps.map((gap) =>
                bullet(
                  `**${DIMENSION[gap.dimension]} / ${gap.topic}**: ${gap.description}${
                    gap.blocking ? ' _(blocking)_' : ''
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

    openGaps.length === 0 && unresolved.length === 0
      ? section(
          'Nothing is outstanding',
          'Every gap identified during gathering was closed. If you find yourself needing to invent a requirement, that is a gap that was missed — raise it rather than filling it in.',
        )
      : '',
  ])}\n`;
};
