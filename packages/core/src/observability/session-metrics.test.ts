import { describe, expect, it } from 'vitest';
import {
  Answer,
  Question,
  Session,
  Turn,
  Understanding,
  UnderstandingRevision,
} from '../domain/index.ts';
import { type MetricsInput, sessionMetrics } from './session-metrics.ts';

/**
 * The arithmetic, pinned without a model.
 *
 * **This separation is the point of the whole eval design.** The *readings* need
 * a live provider; the *instrument* must not, or every number it produces later
 * is unverifiable. An eval run against a scripted fake would measure the
 * fixture — a fake that always picks option zero reports 100% recommendation
 * acceptance, which is a fact about `answerAll` and nothing about anchoring.
 */

const AT = '2026-01-01T00:00:00.000Z';

const usage = (inputTokens: number, outputTokens: number, cost: number | null = null) => ({
  operation: 'analyze' as const,
  provider: 'fake',
  model: 'fake-1',
  inputTokens,
  outputTokens,
  costMinorUnits: cost,
});

const turn = (index: number, overrides: Record<string, unknown> = {}) => {
  // `verdict` is pulled out before the spread: a nested override merged *after*
  // `...overrides` would be replaced wholesale, dropping every required field
  // the caller did not restate.
  const { verdict, ...rest } = overrides;

  return Turn.parse({
    id: `trn-${index + 1}`,
    sessionId: 'ses-1',
    index,
    trigger: 'initial',
    understandingAfter: `rev-${index + 1}`,
    usage: [usage(100, 20)],
    startedAt: AT,
    completedAt: AT,
    ...rest,
    verdict: {
      sufficient: false,
      rationale: 'scripted',
      settled: { decisions: 0, superseded: 0, open: 0, ratio: 0, dimensions: [] },
      coverage: [],
      questionsAsked: 0,
      questionBudget: 12,
      budgetExhausted: false,
      turnsWithoutProgress: 0,
      stalled: false,
      ...((verdict as object) ?? {}),
    },
  });
};

const understanding = (content: Record<string, unknown> = {}) => Understanding.parse(content);

const question = (id: string, overrides: Record<string, unknown> = {}) =>
  Question.parse({
    id,
    sessionId: 'ses-1',
    turnId: 'trn-1',
    dimension: 'users',
    text: 'Who?',
    rationale: 'scripted',
    mode: 'single',
    options: [
      { id: `${id}-opt-1`, label: 'A', commits: 'a' },
      { id: `${id}-opt-2`, label: 'B', commits: 'b' },
    ],
    askedAt: AT,
    ...overrides,
  });

const answer = (questionId: string, selectedOptionIds: string[]) =>
  Answer.parse({ id: `ans-${questionId}`, questionId, selectedOptionIds, answeredAt: AT });

const input = (overrides: Partial<MetricsInput> = {}): MetricsInput => ({
  session: Session.parse({
    id: 'ses-1',
    status: 'sufficient',
    questionBudget: 12,
    createdAt: AT,
    updatedAt: AT,
  }),
  turns: [turn(0), turn(1)],
  questions: [],
  answers: [],
  understanding: understanding(),
  ...overrides,
});

describe('sessionMetrics — cost and outcome', () => {
  it('sums calls and tokens across every turn', () => {
    const metrics = sessionMetrics(
      input({
        turns: [
          turn(0, { usage: [usage(100, 20), usage(50, 10)] }),
          turn(1, { usage: [usage(200, 40)] }),
        ],
      }),
    );

    expect(metrics.calls).toBe(3);
    expect(metrics.usage).toEqual({ inputTokens: 350, outputTokens: 70, costMinorUnits: null });
  });

  it('keeps an unreported cost null rather than calling it free', () => {
    // Same rule as `sumUsage`: "not reported" and "zero" are different claims,
    // and an eval that confused them would report an unpriced model as free.
    const priced = sessionMetrics(input({ turns: [turn(0, { usage: [usage(100, 20, 5)] })] }));
    const unpriced = sessionMetrics(input({ turns: [turn(0, { usage: [usage(100, 20)] })] }));

    expect(priced.usage.costMinorUnits).toBe(5);
    expect(unpriced.usage.costMinorUnits).toBeNull();
  });

  it('reports the turn sufficiency was first reached, 1-based', () => {
    const metrics = sessionMetrics(
      input({ turns: [turn(0), turn(1, { verdict: { sufficient: true } })] }),
    );
    expect(metrics.turnsToSufficient).toBe(2);
  });

  it('reports null when a session never reached sufficiency', () => {
    expect(sessionMetrics(input()).turnsToSufficient).toBeNull();
  });
});

describe('sessionMetrics — the anchoring instrument', () => {
  it('counts how often the recommended option was taken', () => {
    const taken = question('qst-1', { recommends: 'qst-1-opt-1', because: 'cheapest' });
    const ignored = question('qst-2', { recommends: 'qst-2-opt-1', because: 'cheapest' });

    const metrics = sessionMetrics(
      input({
        questions: [taken, ignored],
        answers: [answer('qst-1', ['qst-1-opt-1']), answer('qst-2', ['qst-2-opt-2'])],
      }),
    );

    expect(metrics.recommendationsOffered).toBe(2);
    expect(metrics.recommendationAcceptance).toBe(0.5);
  });

  it('ignores questions that carried no recommendation', () => {
    const metrics = sessionMetrics(
      input({
        questions: [
          question('qst-1'),
          question('qst-2', { recommends: 'qst-2-opt-1', because: 'x' }),
        ],
        answers: [answer('qst-1', ['qst-1-opt-1']), answer('qst-2', ['qst-2-opt-1'])],
      }),
    );

    expect(metrics.recommendationsOffered).toBe(1);
    expect(metrics.recommendationAcceptance).toBe(1);
  });

  it('reports null, not zero, when nothing was ever recommended', () => {
    // A rate over zero offers is undefined, and rendering it as 0% would read as
    // "the user always disagrees" — the opposite of the truth.
    const metrics = sessionMetrics(input({ questions: [question('qst-1')] }));

    expect(metrics.recommendationAcceptance).toBeNull();
    expect(metrics.recommendationsOffered).toBe(0);
  });

  it('does not count an unanswered recommendation as a rejection', () => {
    const metrics = sessionMetrics(
      input({ questions: [question('qst-1', { recommends: 'qst-1-opt-1', because: 'x' })] }),
    );
    expect(metrics.recommendationAcceptance).toBe(0);
    expect(metrics.recommendationsOffered).toBe(1);
  });
});

describe('sessionMetrics — the assumption instrument', () => {
  const assumption = (id: string) => ({
    id,
    statement: 'English only',
    basis: 'no locale mentioned',
    risk: 'low',
    dimension: 'edge-cases',
  });

  it('counts assumptions per turn', () => {
    const metrics = sessionMetrics(
      input({
        understanding: understanding({ assumptions: [assumption('asm-1'), assumption('asm-2')] }),
      }),
    );

    expect(metrics.assumptionsMade).toBe(2);
    expect(metrics.assumptionsPerTurn).toBe(1);
  });

  it('counts an assumption that was promoted away', () => {
    // The one that matters most. A promoted assumption has left the collection,
    // so counting only what remains would hide exactly the ones that got acted
    // on — the opposite of what an overuse instrument should do.
    const metrics = sessionMetrics(
      input({
        understanding: understanding({
          assumptions: [assumption('asm-2')],
          decisions: [
            {
              id: 'dec-1',
              statement: 'English only at launch',
              kind: 'scope',
              dimension: 'edge-cases',
              rationale: 'confirmed',
              promotedFrom: 'asm-1',
              settledBy: 'ans-1',
            },
          ],
        }),
      }),
    );

    expect(metrics.assumptionsMade).toBe(2);
  });

  it('does not count a decision promoted from something else', () => {
    const metrics = sessionMetrics(
      input({
        understanding: understanding({
          decisions: [
            {
              id: 'dec-1',
              statement: 'SSO',
              kind: 'functional',
              dimension: 'core-behaviour',
              rationale: 'confirmed',
              promotedFrom: 'req-1',
              settledBy: 'ans-1',
            },
          ],
        }),
      }),
    );

    expect(metrics.assumptionsMade).toBe(0);
  });
});

describe('sessionMetrics — repairs', () => {
  it('is null when nothing was metering them', () => {
    // Not zero. `Generated.repairs` never reaches a `Turn`, so an unmetered run
    // has no opinion about repairs and must not claim there were none.
    expect(sessionMetrics(input()).repairs).toBeNull();
  });

  it('sums them when a meter was attached', () => {
    expect(sessionMetrics(input({ repairsPerCall: [0, 2, 1] })).repairs).toBe(3);
  });
});

describe('sessionMetrics — settled state', () => {
  it('reports the ratio the whole design is pointed at', () => {
    const metrics = sessionMetrics(
      input({
        understanding: understanding({
          decisions: [
            {
              id: 'dec-1',
              statement: 'SSO',
              kind: 'functional',
              dimension: 'core-behaviour',
              rationale: 'x',
              settledBy: 'src-1',
            },
          ],
          requirements: [{ id: 'req-1', statement: 'open', kind: 'functional', dimension: 'data' }],
        }),
      }),
    );

    expect(metrics.decisions).toBe(1);
    expect(metrics.openItems).toBe(1);
    expect(metrics.settledRatio).toBe(0.5);
  });

  it('survives an empty session without dividing by zero', () => {
    const metrics = sessionMetrics(input({ turns: [] }));

    expect(metrics.turns).toBe(0);
    expect(metrics.assumptionsPerTurn).toBe(0);
    expect(metrics.settledRatio).toBe(0);
  });
});

describe('UnderstandingRevision compatibility', () => {
  it('takes the content a revision stores, so a caller passes what it already has', () => {
    const revision = UnderstandingRevision.parse({
      id: 'rev-1',
      sessionId: 'ses-1',
      revision: 0,
      createdAt: AT,
      content: {},
    });

    expect(() => sessionMetrics(input({ understanding: revision.content }))).not.toThrow();
  });
});
