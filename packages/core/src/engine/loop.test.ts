import { describe, expect, it } from 'vitest';
import {
  UnderstandingAssessment as AssessmentSchema,
  type QuestionDraft,
  QuestionDraft as QuestionDraftSchema,
  type SufficiencyVerdict,
  type Understanding,
  type UnderstandingAssessment,
  Understanding as UnderstandingSchema,
  SufficiencyVerdict as VerdictSchema,
} from '../domain/index.ts';
import { resolveBlockingGaps, selectQuestions } from './loop.ts';

/**
 * The pure parts of the loop. No adapters, so these live in `src/engine/`;
 * anything wiring adapters to the engine is an integration test and lives in
 * `src/integration/`.
 */

const understanding = (
  gaps: readonly { id: string; dimension: string; blocking?: boolean }[],
): Understanding =>
  UnderstandingSchema.parse({
    gaps: gaps.map((gap) => ({
      id: gap.id,
      dimension: gap.dimension,
      topic: gap.id,
      description: 'scripted',
      blocking: gap.blocking ?? false,
      impact: 'medium',
    })),
  });

const assessment = (blockingGapIds: string[]): UnderstandingAssessment =>
  AssessmentSchema.parse({ summary: 'scripted', blockingGapIds, coverage: [] });

const verdict = (shortfalls: string[]): SufficiencyVerdict =>
  VerdictSchema.parse({
    sufficient: false,
    rationale: 'scripted',
    coverage: [],
    shortfalls,
    blockingGapIds: [],
    questionsAsked: 0,
    questionBudget: 12,
    budgetExhausted: false,
  });

const draft = (gapId: string, text = 'Question?'): QuestionDraft =>
  QuestionDraftSchema.parse({ gapId, text, mode: 'single', options: [] });

describe('resolveBlockingGaps', () => {
  it('unions gaps flagged blocking with those the assessment named', () => {
    const result = resolveBlockingGaps(
      understanding([
        { id: 'gap-1', dimension: 'purpose', blocking: true },
        { id: 'gap-2', dimension: 'users' },
      ]),
      assessment(['gap-2']),
    );

    expect(result.sort()).toEqual(['gap-1', 'gap-2']);
  });

  it('drops an invented blocking gap instead of letting it deadlock the session', () => {
    // Unlike a delta, where an unknown ID must fail the turn: a hallucinated
    // blocking gap that survived would veto sufficiency forever.
    const result = resolveBlockingGaps(
      understanding([{ id: 'gap-1', dimension: 'purpose' }]),
      assessment(['gap-99']),
    );

    expect(result).toEqual([]);
  });

  it('does not duplicate a gap named by both sources', () => {
    const result = resolveBlockingGaps(
      understanding([{ id: 'gap-1', dimension: 'purpose', blocking: true }]),
      assessment(['gap-1']),
    );

    expect(result).toEqual(['gap-1']);
  });
});

describe('selectQuestions', () => {
  const gaps = understanding([
    { id: 'gap-acceptance', dimension: 'acceptance' },
    { id: 'gap-users', dimension: 'users' },
    { id: 'gap-data', dimension: 'data' },
  ]);

  it('orders by the domain-computed shortfall order, not by model order', () => {
    const selected = selectQuestions(
      [draft('gap-users'), draft('gap-acceptance')],
      gaps,
      verdict(['acceptance', 'users']),
      10,
    );

    expect(selected.map((q) => q.gapId)).toEqual(['gap-acceptance', 'gap-users']);
  });

  it('sorts questions for non-shortfall dimensions last, keeping model order within a band', () => {
    const selected = selectQuestions(
      [draft('gap-data', 'first'), draft('gap-users', 'second')],
      gaps,
      verdict(['users']),
      10,
    );

    expect(selected.map((q) => q.text)).toEqual(['second', 'first']);
  });

  it('drops questions targeting a gap that is not open', () => {
    const selected = selectQuestions([draft('gap-99'), draft('gap-users')], gaps, verdict([]), 10);
    expect(selected.map((q) => q.gapId)).toEqual(['gap-users']);
  });

  it('truncates to the cap', () => {
    const selected = selectQuestions(
      [draft('gap-acceptance'), draft('gap-users'), draft('gap-data')],
      gaps,
      verdict(['acceptance', 'users', 'data']),
      2,
    );

    expect(selected).toHaveLength(2);
    expect(selected.map((q) => q.gapId)).toEqual(['gap-acceptance', 'gap-users']);
  });
});
