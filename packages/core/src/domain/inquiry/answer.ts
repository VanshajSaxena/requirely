import { z } from 'zod';
import { AnswerId, OptionId, QuestionId } from '../shared/ids.ts';
import { Timestamp } from '../shared/time.ts';

/**
 * What the user did with a question, which is not always "answered it".
 *
 * **"I don't know" used to be unrepresentable.** `validateAnswer` rejected an
 * answer with no selection and no text outright, so the only legal replies were
 * a choice and a written one. That is a fine model for someone who already knows
 * what they want and a bad one for almost everybody else — and it is the same
 * hole as the product's larger one, because a user saying *"you decide"* is
 * exactly the signal that should make Requirely infer rather than ask again.
 *
 * - `answered`  — a choice, prose, or both. The only one that must carry content.
 * - `deferred`  — "ask me later." Carries no information about the subject, and
 *   `listDeferredQuestions` is how it comes back. Deliberately not re-surfaced
 *   automatically: a question that returns every turn is nagging, not deferring.
 * - `delegated` — "you decide, and I'll correct you." The ideation trigger. The
 *   engine tells the model to take a position and record it as an assumption
 *   with its `basis`, so not knowing produces *progress* instead of a stall.
 *
 * All three may carry `customText` as steering — "ask legal first", "whatever is
 * cheapest" — because a user who cannot answer often still knows something
 * useful about why.
 */
export const AnswerDisposition = z.enum(['answered', 'deferred', 'delegated']);
export type AnswerDisposition = z.infer<typeof AnswerDisposition>;

export const Answer = z.object({
  id: AnswerId,
  questionId: QuestionId,
  /** Defaults to `answered`, so every existing caller means what it used to. */
  disposition: AnswerDisposition.default('answered'),
  /** Lowest-effort path: pick from the generated options. */
  selectedOptionIds: z.array(OptionId).default([]),
  /** Highest-flexibility path: say something the options did not cover. */
  customText: z.string().min(1).nullable().default(null),
  /** Volunteered context that answers more than was asked. */
  additionalContext: z.string().min(1).nullable().default(null),
  answeredAt: Timestamp,
});
export type Answer = z.infer<typeof Answer>;
