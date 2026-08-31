import type { CoverageDimension, UnderstandingAssessment } from './coverage.ts';
import { SufficiencyVerdict } from './verdict.ts';

export interface SufficiencyPolicy {
  /** Score a required dimension must reach, inclusive. */
  readonly minimumCoverage: number;
  /**
   * Dimensions that must clear the bar. The others are still scored and still
   * attract questions — they simply do not block finalizing, because demanding
   * full coverage of every dimension makes the loop ask questions forever.
   */
  readonly requiredDimensions: readonly CoverageDimension[];
}

export const DEFAULT_SUFFICIENCY_POLICY: SufficiencyPolicy = {
  minimumCoverage: 0.7,
  requiredDimensions: ['purpose', 'users', 'core-behaviour', 'constraints', 'acceptance'],
};

export interface InquiryProgress {
  readonly questionsAsked: number;
  readonly questionBudget: number;
}

/**
 * Turns a model's assessment into a decision.
 *
 * The model supplies evidence — per-dimension scores and blocking items — and
 * this function applies the policy. That split is what makes the threshold a
 * tunable number rather than a phrase buried in a prompt, and what makes "why
 * isn't this sufficient yet?" answerable from stored data alone.
 *
 * Pure: same inputs, same verdict, no clock and no I/O.
 */
export function decideSufficiency(
  assessment: UnderstandingAssessment,
  policy: SufficiencyPolicy,
  progress: InquiryProgress,
): SufficiencyVerdict {
  const scores = new Map<CoverageDimension, number>(
    assessment.coverage.map((entry) => [entry.dimension, entry.score]),
  );

  // A required dimension the model did not assess scores zero. Treating silence
  // as success is how a loop finalizes on a topic it never considered.
  const shortfalls = policy.requiredDimensions
    .map((dimension) => ({ dimension, score: scores.get(dimension) ?? 0 }))
    .filter((entry) => entry.score < policy.minimumCoverage)
    .sort((a, b) => a.score - b.score);

  const blockingItemIds = assessment.blockingItemIds;
  const sufficient = shortfalls.length === 0 && blockingItemIds.length === 0;
  const budgetExhausted = progress.questionsAsked >= progress.questionBudget;

  const bar = policy.minimumCoverage.toFixed(2);
  const reasons: string[] = [];
  if (shortfalls.length > 0) {
    const detail = shortfalls
      .map((entry) => `${entry.dimension} (${entry.score.toFixed(2)})`)
      .join(', ');
    reasons.push(`coverage below the ${bar} bar for: ${detail}`);
  }
  if (blockingItemIds.length > 0) {
    reasons.push(
      `${blockingItemIds.length} blocking open item${blockingItemIds.length === 1 ? '' : 's'} unsettled`,
    );
  }

  const rationale = sufficient
    ? `Every required dimension meets the ${bar} coverage bar and no blocking items remain open.`
    : `Not yet sufficient: ${reasons.join('; ')}.`;

  return SufficiencyVerdict.parse({
    sufficient,
    rationale,
    coverage: assessment.coverage,
    shortfalls: shortfalls.map((entry) => entry.dimension),
    blockingItemIds,
    questionsAsked: progress.questionsAsked,
    questionBudget: progress.questionBudget,
    budgetExhausted,
  });
}
