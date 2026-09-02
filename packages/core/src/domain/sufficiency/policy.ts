import type { CoverageDimension, UnderstandingAssessment } from './coverage.ts';
import { type SettledProgress, totalSettled } from './progress.ts';
import { SufficiencyVerdict } from './verdict.ts';

export interface SufficiencyPolicy {
  /**
   * Every one of these must have at least one Decision behind it.
   *
   * This is the substance check, and it is the reason a settled *ratio* alone is
   * not enough: promote your single requirement and the ratio is 1.0 after turn
   * one. Requiring a Decision per dimension cannot be gamed that way, and it is
   * countable from the document rather than scored by a model.
   */
  readonly requiredDimensions: readonly CoverageDimension[];
  /**
   * Fraction of items that must be settled.
   *
   * `0.5` is the owner's stated goal written as a number — *"always move towards
   * more Decisions than other uncertain models"* — not a tuned value. It has
   * never been measured against a real session; treat it as a starting position.
   */
  readonly minimumSettledRatio: number;
  /**
   * Turns that may pass with nothing newly settled before the loop is stalled.
   *
   * Two, because one is noise: a turn spent ingesting a document legitimately
   * settles nothing. Two in a row means questions are not landing.
   */
  readonly stallAfterTurnsWithoutProgress: number;
  /**
   * Coverage score below which a dimension is called weak.
   *
   * **Advisory only.** It orders questions and appears in the rationale; it can
   * no longer veto sufficiency. Kept because it catches what counting cannot: a
   * dimension can hold one shallow Decision — "users: product managers" settles
   * nothing about their needs — and a model scoring `users: 0.3` sees that where
   * a count of 1 does not.
   */
  readonly weakCoverageBelow: number;
}

export const DEFAULT_SUFFICIENCY_POLICY: SufficiencyPolicy = {
  requiredDimensions: ['purpose', 'users', 'core-behaviour', 'constraints', 'acceptance'],
  minimumSettledRatio: 0.5,
  stallAfterTurnsWithoutProgress: 2,
  weakCoverageBelow: 0.7,
};

export interface InquiryProgress {
  readonly questionsAsked: number;
  readonly questionBudget: number;
  /** This turn's structural measurement, from `measureProgress`. */
  readonly settled: SettledProgress;
  /** The previous turn's, or null on the first turn. */
  readonly previous: SettledProgress | null;
  /** What the previous turn's verdict recorded. Zero on the first turn. */
  readonly priorTurnsWithoutProgress: number;
}

/**
 * Turns a measurement into a decision.
 *
 * **What changed and why.** This used to take a model's per-dimension coverage
 * scores and compare them to a threshold — evidence supplied by the same model
 * whose work was being judged, which is unfalsifiable in the direction that
 * flatters. Now the three things that decide are counted from the stored
 * document: blocking items, dimensions with a Decision behind them, and the
 * settled ratio. The model's scores still arrive, and are still recorded and
 * used to order questions, but they cannot make a session sufficient.
 *
 * Pure: same inputs, same verdict, no clock and no I/O.
 */
export function decideSufficiency(
  assessment: UnderstandingAssessment,
  policy: SufficiencyPolicy,
  progress: InquiryProgress,
): SufficiencyVerdict {
  const { settled } = progress;
  const scores = new Map<CoverageDimension, number>(
    assessment.coverage.map((entry) => [entry.dimension, entry.score]),
  );
  const withDecision = new Set(settled.dimensions);

  const unsettledDimensions = policy.requiredDimensions.filter(
    (dimension) => !withDecision.has(dimension),
  );

  // A dimension with no Decision at all outranks one that merely scores badly:
  // structure decides the order, and the model's score breaks ties inside each
  // band. That is coverage doing the only job it still has.
  const shortfalls = policy.requiredDimensions
    .map((dimension) => ({
      dimension,
      unsettled: !withDecision.has(dimension),
      score: scores.get(dimension) ?? 0,
    }))
    .filter((entry) => entry.unsettled || entry.score < policy.weakCoverageBelow)
    .sort((a, b) => Number(b.unsettled) - Number(a.unsettled) || a.score - b.score)
    .map((entry) => entry.dimension);

  const blockingItemIds = assessment.blockingItemIds;
  const ratioMet = settled.ratio >= policy.minimumSettledRatio;

  const sufficient = blockingItemIds.length === 0 && unsettledDimensions.length === 0 && ratioMet;

  // Movement is monotonic by construction: Decisions are never deleted, so
  // `totalSettled` can only rise. "Did this turn settle anything new?" is a
  // comparison of two integers rather than a diff of two documents.
  const moved =
    progress.previous === null || totalSettled(settled) > totalSettled(progress.previous);
  const turnsWithoutProgress = moved ? 0 : progress.priorTurnsWithoutProgress + 1;
  const stalled = turnsWithoutProgress >= policy.stallAfterTurnsWithoutProgress;

  const budgetExhausted = progress.questionsAsked >= progress.questionBudget;

  return SufficiencyVerdict.parse({
    sufficient,
    rationale: explain({
      sufficient,
      settled,
      policy,
      unsettledDimensions,
      blockingItemIds,
      ratioMet,
      turnsWithoutProgress,
      stalled,
    }),
    settled,
    coverage: assessment.coverage,
    shortfalls,
    blockingItemIds,
    questionsAsked: progress.questionsAsked,
    questionBudget: progress.questionBudget,
    budgetExhausted,
    turnsWithoutProgress,
    stalled,
  });
}

/**
 * The rationale, assembled from the same facts that produced the boolean.
 *
 * Written from the measurement rather than from the model's prose, so "why isn't
 * this sufficient yet?" is answerable from stored data alone and always agrees
 * with the verdict beside it.
 */
function explain(input: {
  sufficient: boolean;
  settled: SettledProgress;
  policy: SufficiencyPolicy;
  unsettledDimensions: readonly CoverageDimension[];
  blockingItemIds: readonly string[];
  ratioMet: boolean;
  turnsWithoutProgress: number;
  stalled: boolean;
}): string {
  const { settled } = input;
  const counts = `${settled.decisions} settled, ${settled.open} still open`;

  if (input.sufficient) {
    return `Enough is settled to describe what to build: ${counts}, every required dimension has a decision behind it, and no blocking item remains.`;
  }

  const reasons: string[] = [];
  if (input.blockingItemIds.length > 0) {
    const n = input.blockingItemIds.length;
    reasons.push(`${n} blocking open item${n === 1 ? '' : 's'} unsettled`);
  }
  if (input.unsettledDimensions.length > 0) {
    reasons.push(`nothing settled yet for: ${input.unsettledDimensions.join(', ')}`);
  }
  if (!input.ratioMet) {
    reasons.push(
      `only ${(settled.ratio * 100).toFixed(0)}% of items are settled, against a ${(input.policy.minimumSettledRatio * 100).toFixed(0)}% bar`,
    );
  }

  const stall = input.stalled
    ? ` The last ${input.turnsWithoutProgress} turns settled nothing new, so more questions are unlikely to help.`
    : '';

  return `Not yet sufficient (${counts}): ${reasons.join('; ')}.${stall}`;
}
