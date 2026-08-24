import { describe, expect, it } from 'vitest';
import {
  ALL_COVERAGE_DIMENSIONS,
  type CoverageDimension,
  UnderstandingAssessment,
} from './coverage.ts';
import { DEFAULT_SUFFICIENCY_POLICY, decideSufficiency, type SufficiencyPolicy } from './policy.ts';

/** Assessment where every dimension scores `score`, overridden per dimension. */
const assess = (
  score: number,
  overrides: Partial<Record<CoverageDimension, number>> = {},
  blockingGapIds: string[] = [],
) =>
  UnderstandingAssessment.parse({
    summary: 'assessment',
    blockingGapIds,
    coverage: ALL_COVERAGE_DIMENSIONS.map((dimension) => ({
      dimension,
      score: overrides[dimension] ?? score,
      rationale: `${dimension} rationale`,
    })),
  });

const progress = { questionsAsked: 3, questionBudget: 12 };

describe('decideSufficiency', () => {
  it('is sufficient when every required dimension clears the bar and nothing blocks', () => {
    const verdict = decideSufficiency(assess(0.9), DEFAULT_SUFFICIENCY_POLICY, progress);

    expect(verdict.sufficient).toBe(true);
    expect(verdict.shortfalls).toEqual([]);
    expect(verdict.rationale).toContain('0.70 coverage bar');
  });

  it('treats the bar as inclusive', () => {
    expect(decideSufficiency(assess(0.7), DEFAULT_SUFFICIENCY_POLICY, progress).sufficient).toBe(
      true,
    );
    expect(decideSufficiency(assess(0.69), DEFAULT_SUFFICIENCY_POLICY, progress).sufficient).toBe(
      false,
    );
  });

  it('ignores non-required dimensions falling below the bar', () => {
    const verdict = decideSufficiency(
      assess(0.9, { 'edge-cases': 0.1, integrations: 0.0 }),
      DEFAULT_SUFFICIENCY_POLICY,
      progress,
    );
    expect(verdict.sufficient).toBe(true);
  });

  it('scores an unassessed required dimension as zero rather than assuming success', () => {
    const partial = UnderstandingAssessment.parse({
      summary: 'only purpose was assessed',
      coverage: [{ dimension: 'purpose', score: 1, rationale: 'clear' }],
    });

    const verdict = decideSufficiency(partial, DEFAULT_SUFFICIENCY_POLICY, progress);

    expect(verdict.sufficient).toBe(false);
    expect(verdict.shortfalls).toContain('acceptance');
    expect(verdict.shortfalls).not.toContain('purpose');
  });

  it('lists shortfalls weakest first so questions can target the worst gap', () => {
    const verdict = decideSufficiency(
      assess(0.9, { acceptance: 0.1, 'core-behaviour': 0.5, constraints: 0.3 }),
      DEFAULT_SUFFICIENCY_POLICY,
      progress,
    );
    expect(verdict.shortfalls).toEqual(['acceptance', 'constraints', 'core-behaviour']);
  });

  it('lets a single blocking gap veto otherwise perfect coverage', () => {
    const verdict = decideSufficiency(
      assess(1, {}, ['gap-1']),
      DEFAULT_SUFFICIENCY_POLICY,
      progress,
    );

    expect(verdict.sufficient).toBe(false);
    expect(verdict.shortfalls).toEqual([]);
    expect(verdict.rationale).toContain('1 blocking gap unresolved');
  });

  it('keeps budget exhaustion independent of sufficiency', () => {
    const spent = { questionsAsked: 12, questionBudget: 12 };

    const done = decideSufficiency(assess(0.9), DEFAULT_SUFFICIENCY_POLICY, spent);
    expect(done.sufficient).toBe(true);
    expect(done.budgetExhausted).toBe(true);

    // Running out of questions must never manufacture sufficiency — that is the
    // difference between a finished spec and one with stated unknowns.
    const stuck = decideSufficiency(assess(0.2), DEFAULT_SUFFICIENCY_POLICY, spent);
    expect(stuck.sufficient).toBe(false);
    expect(stuck.budgetExhausted).toBe(true);
  });

  it('is tunable by policy without touching any prompt', () => {
    const lenient: SufficiencyPolicy = { minimumCoverage: 0.3, requiredDimensions: ['purpose'] };
    expect(decideSufficiency(assess(0.4), lenient, progress).sufficient).toBe(true);
    expect(decideSufficiency(assess(0.4), DEFAULT_SUFFICIENCY_POLICY, progress).sufficient).toBe(
      false,
    );
  });

  it('produces a rationale naming the failing dimensions and their scores', () => {
    const verdict = decideSufficiency(
      assess(0.9, { acceptance: 0.25 }),
      DEFAULT_SUFFICIENCY_POLICY,
      progress,
    );
    expect(verdict.rationale).toBe(
      'Not yet sufficient: coverage below the 0.70 bar for: acceptance (0.25).',
    );
  });
});
