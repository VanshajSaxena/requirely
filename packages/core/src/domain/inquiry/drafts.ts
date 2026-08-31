import type { z } from 'zod';
import type { Clock } from '../ports/clock.ts';
import type { IdGenerator } from '../ports/id-generator.ts';
import { OptionId, QuestionId, type SessionId, type TurnId } from '../shared/ids.ts';
import { optionListRule, Question, QuestionOption } from './question.ts';

/**
 * What a model may emit when asked for questions.
 *
 * Identity and time are stripped: `id`, `sessionId`, `turnId`, and `askedAt` are
 * the domain's to assign. `dimension` and `about` stay: the model chooses which
 * lens a question serves and, optionally, which existing open item it would
 * settle. It is choosing among things that already exist, not inventing them.
 */

export const QuestionOptionDraft = QuestionOption.omit({ id: true });
export type QuestionOptionDraft = z.infer<typeof QuestionOptionDraft>;

export const QuestionDraft = Question.omit({
  id: true,
  sessionId: true,
  turnId: true,
  askedAt: true,
  options: true,
}).extend({
  options: optionListRule(QuestionOptionDraft),
});
export type QuestionDraft = z.infer<typeof QuestionDraft>;

export interface MaterializeContext {
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/**
 * Assigns identity and time to drafted questions.
 *
 * Pure given the two ports, so a fixed clock and a sequential id generator make
 * question output snapshot-comparable. Options are minted here too — an option
 * id the model invented could collide with one from another question, and
 * `validateAnswer` checks selections against exactly these ids.
 */
export function materializeQuestions(
  drafts: readonly QuestionDraft[],
  scope: { readonly sessionId: SessionId; readonly turnId: TurnId },
  ctx: MaterializeContext,
): Question[] {
  const askedAt = ctx.clock.now();

  return drafts.map((draft) =>
    Question.parse({
      ...draft,
      id: QuestionId.parse(ctx.ids.next('question')),
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      askedAt,
      options: draft.options.map((option) => ({
        ...option,
        id: OptionId.parse(ctx.ids.next('option')),
      })),
    }),
  );
}
