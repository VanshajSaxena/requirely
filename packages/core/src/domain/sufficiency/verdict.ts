import { z } from 'zod';
import { OpenItemId } from '../shared/ids.ts';
import { CoverageAssessment, CoverageDimension } from './coverage.ts';
import { SettledProgress } from './progress.ts';

/**
 * The recorded answer to "do I have enough to confidently describe what needs to
 * be built?" — stored on every Turn.
 *
 * **The verdict is now structural.** It used to be a model's per-dimension
 * scores plus a threshold, which is a model grading its own homework and then
 * being believed. What decides it now is counted from the stored document: are
 * blocking items still open, does every required dimension have a Decision
 * behind it, and are there more Decisions than uncertain items. Coverage
 * survives as a **lens** — reported, and used to order questions — but it no
 * longer votes.
 *
 * Four independent booleans, deliberately not collapsed:
 *
 * - `sufficient` — enough is settled to describe what to build.
 * - `budgetExhausted` — the question budget ran out.
 * - `stalled` — turns are passing and nothing is getting settled.
 *
 * Conflating any two would make "we finished" indistinguishable from "we stopped",
 * and those call for very different output: one is a spec, one is a spec with a
 * stated list of what it had to guess at, and one is a spec plus an admission
 * that asking more questions was not helping.
 */
export const SufficiencyVerdict = z.object({
  sufficient: z.boolean(),
  rationale: z.string().min(1),
  /** What was counted, so the verdict is reproducible from stored data alone. */
  settled: SettledProgress,
  coverage: z.array(CoverageAssessment),
  /**
   * Required dimensions still to settle, worst first — steers the next questions.
   *
   * Ordered structurally first (a dimension with **no** Decision outranks one with
   * a weak score) and by the model's coverage score second. That is coverage
   * doing the only job it still has: breaking ties between things structure
   * cannot distinguish.
   */
  shortfalls: z.array(CoverageDimension).default([]),
  blockingItemIds: z.array(OpenItemId).default([]),
  questionsAsked: z.number().int().nonnegative(),
  questionBudget: z.number().int().positive(),
  budgetExhausted: z.boolean(),
  /**
   * Consecutive turns that settled nothing new, **including this one**.
   *
   * Carried on the verdict rather than recomputed because the verdict is the
   * durable record: the next turn reads this number off the previous turn and
   * either increments it or resets it to zero.
   */
  turnsWithoutProgress: z.number().int().nonnegative().default(0),
  /** `turnsWithoutProgress` has reached the policy's patience. */
  stalled: z.boolean().default(false),
});
export type SufficiencyVerdict = z.infer<typeof SufficiencyVerdict>;
