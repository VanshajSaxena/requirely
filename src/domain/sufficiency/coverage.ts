import { z } from 'zod';
import { GapId } from '../shared/ids.ts';

/**
 * The dimensions along which understanding is judged complete.
 *
 * Every Gap carries one. That link is what makes the sufficiency verdict
 * falsifiable: "not sufficient" resolves to a named dimension, a score, and the
 * specific gaps holding it down — rather than to a paragraph of model prose.
 */
export const CoverageDimension = z.enum([
  'purpose',
  'users',
  'core-behaviour',
  'data',
  'constraints',
  'edge-cases',
  'acceptance',
  'integrations',
]);
export type CoverageDimension = z.infer<typeof CoverageDimension>;

export const ALL_COVERAGE_DIMENSIONS: readonly CoverageDimension[] = CoverageDimension.options;

export const CoverageAssessment = z.object({
  dimension: CoverageDimension,
  /** 0 = nothing known, 1 = enough to build from. */
  score: z.number().min(0).max(1),
  rationale: z.string().min(1),
});
export type CoverageAssessment = z.infer<typeof CoverageAssessment>;

/**
 * What the model returns: evidence, not a verdict.
 *
 * Keeping the boolean out of this shape is deliberate — the decision is made by
 * `decideSufficiency`, so the threshold lives in policy rather than in prompt
 * wording, and can be tuned without re-evaluating prompts.
 */
export const UnderstandingAssessment = z.object({
  coverage: z.array(CoverageAssessment),
  blockingGapIds: z.array(GapId).default([]),
  summary: z.string().min(1),
});
export type UnderstandingAssessment = z.infer<typeof UnderstandingAssessment>;
