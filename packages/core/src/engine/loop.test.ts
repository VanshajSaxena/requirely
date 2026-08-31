import { describe, expect, it } from 'vitest';
import {
  UnderstandingAssessment as AssessmentSchema,
  type CoverageDimension,
  type QuestionDraft,
  QuestionDraft as QuestionDraftSchema,
  type SufficiencyVerdict,
  type Understanding,
  type UnderstandingAssessment,
  Understanding as UnderstandingSchema,
  SufficiencyVerdict as VerdictSchema,
} from '../domain/index.ts';
import { resolveBlockingItems, selectQuestions } from './loop.ts';

/**
 * The pure parts of the loop. No adapters, so these live in `src/engine/`;
 * anything wiring adapters to the engine is an integration test and lives in
 * `src/integration/`.
 */

/** Builds an understanding whose open requirements carry the given ids and lenses. */
const understanding = (
  items: readonly { id: string; dimension: string; blocking?: boolean }[],
): Understanding =>
  UnderstandingSchema.parse({
    requirements: items.map((item) => ({
      id: item.id,
      statement: 'scripted',
      kind: 'functional',
      dimension: item.dimension,
      blocking: item.blocking ?? false,
    })),
  });

const assessment = (blockingItemIds: string[]): UnderstandingAssessment =>
  AssessmentSchema.parse({ summary: 'scripted', blockingItemIds, coverage: [] });

const verdict = (shortfalls: string[]): SufficiencyVerdict =>
  VerdictSchema.parse({
    sufficient: false,
    rationale: 'scripted',
    coverage: [],
    shortfalls,
    blockingItemIds: [],
    questionsAsked: 0,
    questionBudget: 12,
    budgetExhausted: false,
  });

const draft = (
  dimension: CoverageDimension,
  text = 'Question?',
  about: string | null = null,
): QuestionDraft =>
  QuestionDraftSchema.parse({ dimension, about, text, mode: 'single', options: [] });

describe('resolveBlockingItems', () => {
  it('unions items flagged blocking with those the assessment named', () => {
    const result = resolveBlockingItems(
      understanding([
        { id: 'req-1', dimension: 'purpose', blocking: true },
        { id: 'req-2', dimension: 'users' },
      ]),
      assessment(['req-2']),
    );

    expect(result.sort()).toEqual(['req-1', 'req-2']);
  });

  it('drops an invented blocking item instead of letting it deadlock the session', () => {
    // Unlike a delta, where an unknown ID must fail the turn: a hallucinated
    // blocking item that survived would veto sufficiency forever.
    const result = resolveBlockingItems(
      understanding([{ id: 'req-1', dimension: 'purpose' }]),
      assessment(['req-99']),
    );

    expect(result).toEqual([]);
  });

  it('drops an item that was promoted since the assessment named it', () => {
    // Not model error — this is the loop working. An item named blocking on turn
    // N legitimately becomes a Decision on turn N+1, so a stale id is expected.
    const result = resolveBlockingItems(
      UnderstandingSchema.parse({
        decisions: [
          {
            id: 'dec-1',
            statement: 'settled',
            kind: 'functional',
            dimension: 'purpose',
            rationale: 'answered',
            promotedFrom: 'req-1',
            settledBy: 'ans-1',
          },
        ],
      }),
      assessment(['req-1']),
    );

    expect(result).toEqual([]);
  });

  it('does not duplicate an item named by both sources', () => {
    const result = resolveBlockingItems(
      understanding([{ id: 'req-1', dimension: 'purpose', blocking: true }]),
      assessment(['req-1']),
    );

    expect(result).toEqual(['req-1']);
  });
});

describe('selectQuestions', () => {
  const open = understanding([
    { id: 'req-1', dimension: 'acceptance' },
    { id: 'req-2', dimension: 'users' },
    { id: 'req-3', dimension: 'data' },
  ]);

  it('orders by the domain-computed shortfall order, not by model order', () => {
    const selected = selectQuestions(
      [draft('users'), draft('acceptance')],
      open,
      verdict(['acceptance', 'users']),
      10,
    );

    expect(selected.map((q) => q.dimension)).toEqual(['acceptance', 'users']);
  });

  it('sorts questions for non-shortfall dimensions last, keeping model order within a band', () => {
    const selected = selectQuestions(
      [draft('data', 'first'), draft('users', 'second')],
      open,
      verdict(['users']),
      10,
    );

    expect(selected.map((q) => q.text)).toEqual(['second', 'first']);
  });

  it('keeps a question that targets no item at all', () => {
    // The single most important behaviour change from deleting `Gap`. This used
    // to be dropped, so a model could only ask about something it had first
    // invented an entity for — which made turn-one absences unaskable.
    const selected = selectQuestions(
      [draft('acceptance', 'How would you know?')],
      open,
      verdict([]),
      10,
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.about).toBeNull();
  });

  it('clears a stale `about` rather than dropping the question', () => {
    const selected = selectQuestions(
      [draft('users', 'Who uses this?', 'req-99')],
      open,
      verdict([]),
      10,
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.about).toBeNull();
  });

  it('preserves an `about` that still names an open item', () => {
    const selected = selectQuestions([draft('users', 'Who?', 'req-2')], open, verdict([]), 10);
    expect(selected[0]?.about).toBe('req-2');
  });

  it('truncates to the cap', () => {
    const selected = selectQuestions(
      [draft('acceptance'), draft('users'), draft('data')],
      open,
      verdict(['acceptance', 'users', 'data']),
      2,
    );

    expect(selected).toHaveLength(2);
    expect(selected.map((q) => q.dimension)).toEqual(['acceptance', 'users']);
  });
});
