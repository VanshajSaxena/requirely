import { z } from 'zod';
import { OpenItemId } from '../shared/ids.ts';
import { CoverageAssessment, CoverageDimension } from './coverage.ts';

/**
 * The recorded answer to "do I have enough to confidently describe what needs to
 * be built?" — stored on every Turn.
 *
 * `sufficient` and `budgetExhausted` are deliberately independent. Conflating
 * them would make "we finished" indistinguishable from "we ran out of questions",
 * and those call for very different output: one is a spec, the other is a spec
 * with a stated list of what it had to guess at.
 */
export const SufficiencyVerdict = z.object({
  sufficient: z.boolean(),
  rationale: z.string().min(1),
  coverage: z.array(CoverageAssessment),
  /** Required dimensions below the policy bar, weakest first — steers the next questions. */
  shortfalls: z.array(CoverageDimension).default([]),
  blockingItemIds: z.array(OpenItemId).default([]),
  questionsAsked: z.number().int().nonnegative(),
  questionBudget: z.number().int().positive(),
  budgetExhausted: z.boolean(),
});
export type SufficiencyVerdict = z.infer<typeof SufficiencyVerdict>;
