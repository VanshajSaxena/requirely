import { z } from 'zod';
import { currentDecisions, openItems, type Understanding } from '../understanding/understanding.ts';
import { CoverageDimension } from './coverage.ts';

/**
 * The structural measurement behind a sufficiency verdict.
 *
 * Everything here is **counted from the stored document**, not reported by a
 * model. That is the whole point of the change: the previous verdict asked a
 * model to score its own understanding and then believed the score, which is a
 * model grading its own homework. These numbers cannot be flattered.
 */

export const SettledProgress = z.object({
  /** Current Decisions — `supersededBy === null`. */
  decisions: z.number().int().nonnegative(),
  /**
   * Decisions that were later replaced.
   *
   * Counted separately because a supersession leaves `decisions` unchanged while
   * genuinely being progress: something wrong got corrected. Without this,
   * a turn that fixed a decision would read as a turn that did nothing.
   */
  superseded: z.number().int().nonnegative(),
  /** Requirements, constraints, assumptions and contradictions still unsettled. */
  open: z.number().int().nonnegative(),
  /**
   * `decisions / (decisions + open)`, or 0 when the document is empty.
   *
   * The owner's goal stated as a number: *"always move towards more Decisions
   * than other uncertain models."* Above 0.5 is literally that.
   */
  ratio: z.number().min(0).max(1),
  /** Every dimension with at least one current Decision behind it. */
  dimensions: z.array(CoverageDimension).default([]),
});
export type SettledProgress = z.infer<typeof SettledProgress>;

/**
 * Total settlings ever made, including ones later replaced.
 *
 * This is the movement measure, and it is monotonic by construction: Decisions
 * are never deleted, so it can only go up. "Did this turn settle anything new?"
 * is therefore a comparison of two integers rather than a diff.
 */
export const totalSettled = (progress: SettledProgress): number =>
  progress.decisions + progress.superseded;

export function measureProgress(understanding: Understanding): SettledProgress {
  const current = currentDecisions(understanding);
  const open = openItems(understanding).length;
  const decisions = current.length;

  return SettledProgress.parse({
    decisions,
    superseded: understanding.decisions.length - decisions,
    open,
    ratio: decisions + open === 0 ? 0 : decisions / (decisions + open),
    dimensions: [...new Set(current.map((decision) => decision.dimension))],
  });
}

export const emptyProgress = (): SettledProgress =>
  SettledProgress.parse({ decisions: 0, superseded: 0, open: 0, ratio: 0 });
