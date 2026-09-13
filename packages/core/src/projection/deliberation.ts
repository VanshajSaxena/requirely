import type {
  Answer,
  Decision,
  DecisionId,
  Question,
  QuestionOption,
  Source,
} from '../domain/index.ts';
import type { ProjectionInput } from './types.ts';

/**
 * How a Decision came to be decided.
 *
 * **This is the single most valuable thing an ADR provides**, and the reason
 * `ProjectionInput` was widened. MADR's most-cited section is *Considered
 * Options with pros and cons*, because "why not X?" is the question a
 * specification can otherwise never answer — and it is the question that gets
 * re-asked in every review until someone writes the answer down.
 *
 * **Nothing is duplicated onto the Decision to get it.** `settledBy` names an
 * `Answer`, which names its `Question`, which holds every `Option` and what each
 * one `means`. Copying the alternatives onto the Decision would
 * denormalise what a durable reference already reaches — and would then need
 * keeping in sync with the question it came from.
 *
 * Pure: a lookup over what the caller already fetched. No repository, no I/O, so
 * a projection stays snapshot-testable.
 */

export interface Deliberation {
  readonly question: Question;
  readonly answer: Answer;
  /** Options the user selected. Empty when they wrote a custom answer instead. */
  readonly chosen: readonly QuestionOption[];
  /** Everything offered and not taken — the "considered and rejected" half. */
  readonly rejected: readonly QuestionOption[];
  /** What the user wrote instead of choosing, when they did. */
  readonly custom: string | null;
  /**
   * The option Requirely suggested and the user did **not** take.
   *
   * Null when there was no recommendation, or when the user took it. Rendered
   * because "we suggested X, they chose Y" is the most informative line in the
   * whole trail: it records the product's judgement being overridden, which is
   * exactly what a reviewer should see and what an anchoring check counts.
   */
  readonly overrode: QuestionOption | null;
}

/**
 * Deliberations by decision id, for every Decision an answer settled.
 *
 * Source-settled decisions are absent by construction — there was no question,
 * so there is nothing to show. Callers render those from `settledBy` directly.
 *
 * A `settledBy` naming an answer nobody supplied is **dropped, not thrown**. Same
 * asymmetry the engine uses: an unknown reference in a *delta* must fail the
 * turn, but an unknown reference while *rendering* costs one absent paragraph
 * where throwing costs the whole document.
 */
export function deliberations(input: ProjectionInput): Map<DecisionId, Deliberation> {
  const answersById = new Map(input.answers.map((answer) => [answer.id as string, answer]));
  const questionsById = new Map(
    input.questions.map((question) => [question.id as string, question]),
  );

  const found = new Map<DecisionId, Deliberation>();

  for (const decision of input.revision.content.decisions) {
    const answer = answersById.get(decision.settledBy);
    if (answer === undefined) continue;

    const question = questionsById.get(answer.questionId);
    if (question === undefined) continue;

    const selected = new Set<string>(answer.selectedOptionIds);
    const chosen = question.options.filter((option) => selected.has(option.id));
    const rejected = question.options.filter((option) => !selected.has(option.id));
    const recommended = question.options.find((option) => option.id === question.recommends);

    found.set(decision.id, {
      question,
      answer,
      chosen,
      rejected,
      custom: answer.customText,
      overrode: recommended !== undefined && !selected.has(recommended.id) ? recommended : null,
    });
  }

  return found;
}

/**
 * What settled a decision, in one human-readable clause.
 *
 * `settledBy` is an id, and an id is not an explanation. An answer becomes the
 * question that was asked; a source becomes its label rather than `src-1`.
 */
export function settledByLabel(
  decision: Decision,
  deliberation: Deliberation | undefined,
  sources: readonly Source[],
): string {
  if (deliberation !== undefined) return `answering "${deliberation.question.text}"`;

  const source = sources.find((candidate) => candidate.id === decision.settledBy);
  return source === undefined ? `${decision.settledBy}` : `${source.origin.label} (${source.id})`;
}
