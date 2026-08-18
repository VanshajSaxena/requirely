import { z } from 'zod';
import { AnswerId, OptionId, QuestionId } from '../shared/ids.ts';
import { Timestamp } from '../shared/time.ts';

export const Answer = z.object({
  id: AnswerId,
  questionId: QuestionId,
  /** Lowest-effort path: pick from the generated options. */
  selectedOptionIds: z.array(OptionId).default([]),
  /** Highest-flexibility path: say something the options did not cover. */
  customText: z.string().min(1).nullable().default(null),
  /** Volunteered context that answers more than was asked. */
  additionalContext: z.string().min(1).nullable().default(null),
  answeredAt: Timestamp,
});
export type Answer = z.infer<typeof Answer>;
