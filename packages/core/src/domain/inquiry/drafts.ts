import { z } from 'zod';
import type { Clock } from '../ports/clock.ts';
import type { IdGenerator } from '../ports/id-generator.ts';
import { OptionId, QuestionId, type SessionId, type TurnId } from '../shared/ids.ts';
import { optionListRule, Question, QuestionOption, QuestionShape } from './question.ts';

/**
 * What a model may emit when asked for questions.
 *
 * Identity and time are stripped: `id`, `sessionId`, `turnId`, and `askedAt` are
 * the domain's to assign. `dimension` and `about` stay: the model chooses which
 * lens a question serves and, optionally, which existing open item it would
 * settle. It is choosing among things that already exist, not inventing them.
 *
 * **`recommends` is an index here and an `OptionId` on the entity.** Option ids
 * are minted by `materializeQuestions`, so a model cannot name one — the same
 * rule that produced this file in the first place. It points at a position in
 * its own `options` array and the domain translates it.
 *
 * Derived from `QuestionShape` rather than `Question`: `.omit()` throws at
 * runtime on a schema carrying refinements, and the entity's cross-field rules
 * are about `OptionId`s that do not exist yet at draft time.
 */

export const QuestionOptionDraft = QuestionOption.omit({ id: true });
export type QuestionOptionDraft = z.infer<typeof QuestionOptionDraft>;

export const QuestionDraft = QuestionShape.omit({
  id: true,
  sessionId: true,
  turnId: true,
  askedAt: true,
  options: true,
  recommends: true,
})
  .extend({
    options: optionListRule(QuestionOptionDraft),
    /** 0-based position in `options`, or null for no recommendation. */
    recommends: z.number().int().nonnegative().nullable().default(null),
  })
  .refine((draft) => draft.recommends === null || draft.recommends < draft.options.length, {
    message: "A recommendation must point at one of this question's own options.",
    path: ['recommends'],
  })
  /**
   * The same pairing rule the entity enforces, and it has to be **here** too.
   *
   * Found by the first self-gathering run. The rule lived only on `Question`, so
   * a model that set `recommends` and omitted `because` produced a *valid draft*
   * — `withValidationRetry` saw a success, never re-asked, and the failure
   * surfaced later inside `materializeQuestions` as an unrecoverable crash on a
   * call that had already been paid for.
   *
   * The general rule this taught: **the draft is what a model is held to.** Any
   * constraint a model can violate belongs on the draft, or violating it costs a
   * turn instead of a retry. A rule that exists only on the entity is a rule the
   * model can never be told about.
   */
  .refine((draft) => draft.recommends === null || draft.because !== null, {
    message: 'A recommendation must say why. Set `because` alongside `recommends`, or set neither.',
    path: ['because'],
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
 *
 * The recommendation is translated from an index to the id minted for that
 * position. An out-of-range index is impossible: the draft schema rejects it,
 * so by the time a draft reaches here the index is known to be in bounds.
 */
export function materializeQuestions(
  drafts: readonly QuestionDraft[],
  scope: { readonly sessionId: SessionId; readonly turnId: TurnId },
  ctx: MaterializeContext,
): Question[] {
  const askedAt = ctx.clock.now();

  return drafts.map((draft) => {
    const options = draft.options.map((option) => ({
      ...option,
      id: OptionId.parse(ctx.ids.next('option')),
    }));

    return Question.parse({
      ...draft,
      id: QuestionId.parse(ctx.ids.next('question')),
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      askedAt,
      options,
      recommends: draft.recommends === null ? null : (options[draft.recommends]?.id ?? null),
    });
  });
}
