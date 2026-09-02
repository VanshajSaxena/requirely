import { describe, expect, it } from 'vitest';
import {
  ALL_COVERAGE_DIMENSIONS,
  type CoverageDimension,
  UnderstandingAssessment,
} from './coverage.ts';
import { DEFAULT_SUFFICIENCY_POLICY, decideSufficiency, type InquiryProgress } from './policy.ts';
import { type SettledProgress, SettledProgress as SettledProgressSchema } from './progress.ts';

/**
 * The verdict, which used to be a model grading its own homework.
 *
 * These tests are written against the *measurement*, not against coverage
 * scores, and several of them exist specifically to pin that coverage can no
 * longer make a session sufficient.
 */

const REQUIRED = DEFAULT_SUFFICIENCY_POLICY.requiredDimensions;

/** Assessment where every dimension scores `score`, overridden per dimension. */
const assess = (
  score: number,
  overrides: Partial<Record<CoverageDimension, number>> = {},
  blockingItemIds: string[] = [],
) =>
  UnderstandingAssessment.parse({
    summary: 'assessment',
    blockingItemIds,
    coverage: ALL_COVERAGE_DIMENSIONS.map((dimension) => ({
      dimension,
      score: overrides[dimension] ?? score,
      rationale: `${dimension} rationale`,
    })),
  });

const settled = (input: Partial<SettledProgress> = {}): SettledProgress =>
  SettledProgressSchema.parse({
    decisions: 5,
    superseded: 0,
    open: 1,
    ratio: 5 / 6,
    dimensions: [...REQUIRED],
    ...input,
  });

const progress = (input: Partial<InquiryProgress> = {}): InquiryProgress => ({
  questionsAsked: 3,
  questionBudget: 12,
  settled: settled(),
  previous: null,
  priorTurnsWithoutProgress: 0,
  ...input,
});

describe('decideSufficiency — what actually decides', () => {
  it('is sufficient when every required dimension has a decision and most items are settled', () => {
    const verdict = decideSufficiency(assess(0.9), DEFAULT_SUFFICIENCY_POLICY, progress());

    expect(verdict.sufficient).toBe(true);
    expect(verdict.shortfalls).toEqual([]);
    expect(verdict.rationale).toContain('5 settled, 1 still open');
  });

  it('is not sufficient while a required dimension has nothing settled', () => {
    // The substance check, and the reason a ratio alone is not enough.
    const verdict = decideSufficiency(
      assess(1),
      DEFAULT_SUFFICIENCY_POLICY,
      progress({ settled: settled({ dimensions: REQUIRED.slice(1) }) }),
    );

    expect(verdict.sufficient).toBe(false);
    expect(verdict.rationale).toContain('nothing settled yet for');
  });

  it('cannot be talked into sufficiency by perfect coverage scores', () => {
    // The whole point of the rewrite. A model scoring itself 1.0 across every
    // dimension changes nothing while the document holds no decisions.
    const verdict = decideSufficiency(
      assess(1),
      DEFAULT_SUFFICIENCY_POLICY,
      progress({ settled: settled({ decisions: 0, open: 4, ratio: 0, dimensions: [] }) }),
    );

    expect(verdict.sufficient).toBe(false);
  });

  it('cannot be talked out of sufficiency by terrible coverage scores', () => {
    // The other direction, which matters just as much: coverage is advisory, so
    // low scores order questions but cannot veto a settled document.
    const verdict = decideSufficiency(assess(0.1), DEFAULT_SUFFICIENCY_POLICY, progress());

    expect(verdict.sufficient).toBe(true);
    // It still says the dimensions are weak — reported, not obeyed.
    expect(verdict.shortfalls.length).toBeGreaterThan(0);
  });

  it('refuses a document with one settled decision and nothing else', () => {
    // Promote your only requirement and the ratio is 1.0. That is exactly what
    // the per-dimension check exists to catch.
    const verdict = decideSufficiency(
      assess(1),
      DEFAULT_SUFFICIENCY_POLICY,
      progress({
        settled: settled({ decisions: 1, open: 0, ratio: 1, dimensions: ['purpose'] }),
      }),
    );

    expect(verdict.sufficient).toBe(false);
  });

  it('requires more decisions than uncertain items', () => {
    // The owner's goal written as a number: above 0.5 is literally "more
    // Decisions than other uncertain models".
    const verdict = decideSufficiency(
      assess(1),
      DEFAULT_SUFFICIENCY_POLICY,
      progress({ settled: settled({ decisions: 5, open: 9, ratio: 5 / 14 }) }),
    );

    expect(verdict.sufficient).toBe(false);
    expect(verdict.rationale).toContain('36% of items are settled');
  });

  it('lets a single blocking open item veto an otherwise finished document', () => {
    const verdict = decideSufficiency(
      assess(1, {}, ['req-1']),
      DEFAULT_SUFFICIENCY_POLICY,
      progress(),
    );

    expect(verdict.sufficient).toBe(false);
    expect(verdict.rationale).toContain('1 blocking open item');
  });
});

describe('decideSufficiency — shortfalls, which order the next questions', () => {
  it('puts a dimension with no decision ahead of one that merely scores badly', () => {
    // Structure decides the band; the model's score breaks ties inside it. That
    // is the only job coverage still has, and this is what it looks like.
    const verdict = decideSufficiency(
      assess(0.2, { users: 0.9, acceptance: 0.4 }),
      DEFAULT_SUFFICIENCY_POLICY,
      progress({ settled: settled({ dimensions: ['users', 'acceptance'] }) }),
    );

    // `purpose`, `core-behaviour` and `constraints` have no decision at all, so
    // they lead — ordered among themselves by score. `acceptance` is settled but
    // weak, so it trails.
    expect(verdict.shortfalls.slice(0, 3).sort()).toEqual([
      'constraints',
      'core-behaviour',
      'purpose',
    ]);
    expect(verdict.shortfalls.at(-1)).toBe('acceptance');
    // `users` scores 0.9 and is settled, so it is not a shortfall at all.
    expect(verdict.shortfalls).not.toContain('users');
  });

  it('treats an unassessed dimension as zero rather than as fine', () => {
    const sparse = UnderstandingAssessment.parse({
      summary: 'partial',
      blockingItemIds: [],
      coverage: [{ dimension: 'purpose', score: 1, rationale: 'clear' }],
    });

    const verdict = decideSufficiency(sparse, DEFAULT_SUFFICIENCY_POLICY, progress());
    // Every required dimension has a decision, so this is still sufficient —
    // but silence about a dimension must never read as a good score.
    expect(verdict.shortfalls).toContain('users');
  });
});

describe('decideSufficiency — trajectory', () => {
  it('counts a turn that settled nothing new', () => {
    const same = settled();
    const verdict = decideSufficiency(
      assess(0.5),
      DEFAULT_SUFFICIENCY_POLICY,
      progress({ settled: same, previous: same, priorTurnsWithoutProgress: 0 }),
    );

    expect(verdict.turnsWithoutProgress).toBe(1);
    expect(verdict.stalled).toBe(false);
  });

  it('declares a stall once the policy runs out of patience', () => {
    const same = settled({ dimensions: ['purpose'] });
    const verdict = decideSufficiency(
      assess(0.5),
      DEFAULT_SUFFICIENCY_POLICY,
      progress({ settled: same, previous: same, priorTurnsWithoutProgress: 1 }),
    );

    expect(verdict.turnsWithoutProgress).toBe(2);
    expect(verdict.stalled).toBe(true);
    expect(verdict.rationale).toContain('more questions are unlikely to help');
  });

  it('resets the counter the moment something is settled', () => {
    const verdict = decideSufficiency(
      assess(0.5),
      DEFAULT_SUFFICIENCY_POLICY,
      progress({
        settled: settled({ decisions: 6 }),
        previous: settled({ decisions: 5 }),
        priorTurnsWithoutProgress: 5,
      }),
    );

    expect(verdict.turnsWithoutProgress).toBe(0);
    expect(verdict.stalled).toBe(false);
  });

  it('counts a supersession as progress', () => {
    // A supersession leaves the current decision count unchanged while genuinely
    // being progress: something wrong got corrected. Measuring only `decisions`
    // would read a correction as a turn that did nothing.
    const verdict = decideSufficiency(
      assess(0.5),
      DEFAULT_SUFFICIENCY_POLICY,
      progress({
        settled: settled({ decisions: 5, superseded: 1 }),
        previous: settled({ decisions: 5, superseded: 0 }),
        priorTurnsWithoutProgress: 1,
      }),
    );

    expect(verdict.turnsWithoutProgress).toBe(0);
  });

  it('never stalls on the first turn, where there is nothing to compare against', () => {
    const verdict = decideSufficiency(
      assess(0.5),
      DEFAULT_SUFFICIENCY_POLICY,
      progress({ settled: settled({ decisions: 0, open: 3, ratio: 0, dimensions: [] }) }),
    );

    expect(verdict.turnsWithoutProgress).toBe(0);
  });

  it('keeps stalling, budget exhaustion and sufficiency independent', () => {
    // Three different reasons to stop, and a caller that conflated any two would
    // tell the user the wrong thing to do about it.
    const same = settled({ dimensions: ['purpose'] });
    const verdict = decideSufficiency(
      assess(0.5),
      DEFAULT_SUFFICIENCY_POLICY,
      progress({
        settled: same,
        previous: same,
        priorTurnsWithoutProgress: 1,
        questionsAsked: 12,
        questionBudget: 12,
      }),
    );

    expect(verdict.sufficient).toBe(false);
    expect(verdict.stalled).toBe(true);
    expect(verdict.budgetExhausted).toBe(true);
  });
});
