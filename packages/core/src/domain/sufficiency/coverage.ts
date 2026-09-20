import { z } from 'zod';
import { OpenItemId } from '../shared/ids.ts';

/**
 * The dimensions along which understanding is judged complete.
 *
 * Every open item and every Decision carries one. That link is what makes the
 * sufficiency verdict falsifiable: "not sufficient" resolves to a named
 * dimension, a score, and the specific items holding it down — rather than to a
 * paragraph of model prose.
 *
 * Since `Gap` was deleted, a dimension is also how an *absence* is expressed.
 * "Nobody has said how success is measured" is not an entity; it is the
 * `acceptance` dimension scoring low with no decisions behind it. That is why
 * the dimension survived the redesign as a **lens** while the verdict moved to
 * structural signals.
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
  /**
   * Required, not defaulted, and the reason is a provider constraint.
   *
   * A `.default([])` makes the field *optional* in the emitted JSON Schema — it
   * lands in `properties` but not in `required` — and OpenAI's strict mode
   * rejects exactly that, taking `assess` and `analyze-and-assess` down with it.
   * Requiring it drops both to zero optional properties, so they keep
   * constrained decoding on every provider rather than degrading.
   *
   * It is also the more honest shape: the prompt already tells the model to list
   * the blocking ids, so an always-present array is what is being asked for. An
   * omission now fails at the boundary instead of silently becoming `[]`.
   */
  blockingItemIds: z.array(OpenItemId),
  summary: z.string().min(1),
});
export type UnderstandingAssessment = z.infer<typeof UnderstandingAssessment>;
