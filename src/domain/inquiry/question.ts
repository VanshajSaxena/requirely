import { z } from 'zod';
import { GapId, OptionId, QuestionId, SessionId, TurnId } from '../shared/ids.ts';
import { Timestamp } from '../shared/time.ts';

/** Some questions admit exactly one answer, others several. Both are required by the spec. */
export const AnswerMode = z.enum(['single', 'multiple']);
export type AnswerMode = z.infer<typeof AnswerMode>;

export const QuestionOption = z.object({
  id: OptionId,
  label: z.string().min(1),
  /** Expands the trade-off behind an option, for choices that aren't self-evident. */
  elaboration: z.string().min(1).nullable().default(null),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

export const Question = z.object({
  id: QuestionId,
  sessionId: SessionId,
  turnId: TurnId,
  /** Every question exists to close a specific gap — no gap, no question. */
  gapId: GapId,
  text: z.string().min(1),
  mode: AnswerMode,
  /**
   * Zero options means a genuinely open question; two or more offer the
   * low-effort path. Exactly one is rejected: a single option is not a choice,
   * it is a leading question.
   */
  options: z
    .array(QuestionOption)
    .refine((options) => options.length !== 1, {
      message: 'A question must offer either no options or at least two.',
    })
    .default([]),
  /**
   * Always true, encoded in the type. The highest-flexibility path is a product
   * invariant, so it must not be possible to construct a question that forbids
   * a custom answer.
   */
  allowsCustom: z.literal(true).default(true),
  rationale: z.string().min(1).nullable().default(null),
  askedAt: Timestamp,
});
export type Question = z.infer<typeof Question>;
