import { describe, expect, it } from 'vitest';
import { type FakeScript, fakeStructuredGenerator } from '../adapters/ai/fake.ts';
import { inMemoryStores } from '../adapters/storage/memory.ts';
import {
  Answer,
  createSession,
  DEFAULT_SUFFICIENCY_POLICY,
  InvalidAnswerError,
  type Session,
  type SourceId,
  type TurnCommit,
  type TurnCommitter,
} from '../domain/index.ts';
// Test doubles are intentionally absent from the domain's public index, so they
// can never arrive in production code by accident.
import { fixedClock, sequentialIdGenerator } from '../domain/testing/fakes.ts';
import { type EngineDeps, runTurn, type TurnRequest } from '../engine/loop.ts';
import { STRATEGIES, type StrategyName } from '../engine/strategies.ts';
import { ingestText } from '../ingestion/text.ts';
import { answerAll, SOURCE_TEXT, scriptFor, TURN_1_ASSESSMENT, TURN_1_DELTA } from './scenario.ts';

/**
 * The whole loop, end to end, with no provider package installed.
 *
 * If this passes, the ports held: the engine never learns which model produced
 * anything. Everything here is deterministic — a sequential id generator and a
 * fixed clock — which is also what lets fixtures reference ids like `gap-1`
 * before they have been minted.
 */

function harness(strategy: StrategyName = 'separate', script?: FakeScript) {
  const ids = sequentialIdGenerator();
  const clock = fixedClock('2026-01-01T00:00:00.000Z');
  const stores = inMemoryStores();
  const generator = fakeStructuredGenerator(script ?? scriptFor(strategy));

  const deps: EngineDeps & { committer: TurnCommitter } = {
    generator,
    sessions: stores.sessions,
    sources: stores.sources,
    revisions: stores.understanding,
    inquiry: stores.inquiry,
    committer: stores.committer,
    clock,
    ids,
    policy: DEFAULT_SUFFICIENCY_POLICY,
    strategy: STRATEGIES[strategy],
    maxQuestionsPerTurn: 4,
  };

  return { deps, generator, ids, clock, stores };
}

/**
 * The two steps, kept visibly separate.
 *
 * `runTurn` reads, calls models, and returns a command; committing is a distinct
 * act. Tests that expect a turn to *fail* call `runTurn` directly and assert
 * nothing was written — which is only meaningful because these are two steps.
 */
async function runAndCommit(
  session: Session,
  request: TurnRequest,
  deps: EngineDeps & { committer: TurnCommitter },
): Promise<TurnCommit> {
  const commit = await runTurn(session, request, deps);
  await deps.committer.commit(commit);
  return commit;
}

async function seedSession(
  h: ReturnType<typeof harness>,
  questionBudget = 12,
): Promise<{ session: Session; sourceId: SourceId }> {
  const session = createSession({ questionBudget, title: 'Requirely' }, h.deps);
  await h.deps.sessions.create(session);

  const source = ingestText(
    {
      sessionId: session.id,
      label: 'kickoff notes',
      text: SOURCE_TEXT,
      // First source in this session, so `src-1`.
      ordinal: 1,
    },
    h.deps,
  );
  await h.deps.sources.add(source);

  return { session, sourceId: source.id };
}

describe('runTurn — the gathering loop', () => {
  it('turn 1 builds an understanding, finds gaps, and asks about them', async () => {
    const h = harness();
    const { session, sourceId } = await seedSession(h);

    const result = await runAndCommit(
      session,
      { trigger: 'initial', sourceIds: [sourceId] },
      h.deps,
    );

    expect(result.session.status).toBe('awaiting-answers');
    expect(result.revision.revision).toBe(0);
    expect(result.revision.content.requirements).toHaveLength(1);
    expect(result.revision.content.gaps).toHaveLength(2);
    expect(result.questions).toHaveLength(2);
    expect(result.session.questionsAsked).toBe(2);

    // The verdict is recorded and readable, not merely computed.
    expect(result.turn.verdict.sufficient).toBe(false);
    expect(result.turn.verdict.shortfalls).toEqual(['acceptance', 'users']);
    expect(result.turn.verdict.rationale).toContain('acceptance (0.20)');
  });

  it('assigns ids to questions and options rather than trusting the model', async () => {
    const h = harness();
    const { session, sourceId } = await seedSession(h);

    const { questions } = await runAndCommit(
      session,
      { trigger: 'initial', sourceIds: [sourceId] },
      h.deps,
    );

    expect(questions[0]?.id).toBe('qst-1');
    expect(questions[0]?.options.map((o) => o.id)).toEqual(['opt-1', 'opt-2']);
    expect(questions[1]?.options.map((o) => o.id)).toEqual(['opt-3', 'opt-4', 'opt-5']);
    expect(questions.every((q) => q.allowsCustom)).toBe(true);
  });

  it('turn 2 folds answers in, resolves the gaps, and reaches sufficiency', async () => {
    const h = harness();
    const { session, sourceId } = await seedSession(h);

    const first = await runAndCommit(
      session,
      { trigger: 'initial', sourceIds: [sourceId] },
      h.deps,
    );
    const second = await runAndCommit(
      first.session,
      { trigger: 'answers-received', answers: answerAll(first.questions) },
      h.deps,
    );

    expect(second.session.status).toBe('sufficient');
    expect(second.turn.verdict.sufficient).toBe(true);
    expect(second.revision.revision).toBe(1);
    expect(second.revision.content.gaps).toHaveLength(0);
    expect(second.revision.content.resolvedGaps).toHaveLength(2);
    // Turn 1's requirement survived turn 2 untouched — the property deltas exist for.
    expect(second.revision.content.requirements).toHaveLength(2);
    expect(second.revision.content.requirements[0]?.id).toBe('req-1');
    h.generator.assertScriptDrained();
  });

  it('records every revision so the session can be replayed', async () => {
    const h = harness();
    const { session, sourceId } = await seedSession(h);
    const first = await runAndCommit(
      session,
      { trigger: 'initial', sourceIds: [sourceId] },
      h.deps,
    );
    await runAndCommit(
      first.session,
      { trigger: 'answers-received', answers: answerAll(first.questions) },
      h.deps,
    );

    const revisions = await h.deps.revisions.listBySession(session.id);
    const turns = await h.deps.sessions.listTurns(session.id);

    expect(revisions.map((r) => r.revision)).toEqual([0, 1]);
    expect(turns.map((t) => t.index)).toEqual([0, 1]);
    expect(turns[1]?.understandingBefore).toBe(revisions[0]?.id);
    expect(turns[1]?.understandingAfter).toBe(revisions[1]?.id);
  });

  it('attributes token usage per operation', async () => {
    const h = harness();
    const { session, sourceId } = await seedSession(h);
    const result = await runAndCommit(
      session,
      { trigger: 'initial', sourceIds: [sourceId] },
      h.deps,
    );

    const operations = result.turn.usage.map((u) => u.operation);
    expect(operations).toEqual(['analyze', 'assess', 'generate-questions']);
    expect(result.turn.usage.every((u) => u.inputTokens > 0)).toBe(true);
  });
});

describe('runTurn — refusing to waste tokens or deadlock', () => {
  it('rejects a malformed answer before making any model call', async () => {
    const h = harness();
    const { session, sourceId } = await seedSession(h);
    const first = await runAndCommit(
      session,
      { trigger: 'initial', sourceIds: [sourceId] },
      h.deps,
    );
    const callsSoFar = h.generator.calls.length;

    const empty = Answer.parse({
      id: 'ans-1',
      questionId: first.questions[0]?.id,
      answeredAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(
      runTurn(first.session, { trigger: 'answers-received', answers: [empty] }, h.deps),
    ).rejects.toThrow(InvalidAnswerError);
    expect(h.generator.calls.length).toBe(callsSoFar);
  });

  it('lands in exhausted, not sufficient, when the budget is spent', async () => {
    const h = harness('separate', {
      analyze: [TURN_1_DELTA],
      assess: [TURN_1_ASSESSMENT],
    });
    const { session, sourceId } = await seedSession(h, 1);
    const spent: Session = { ...session, questionsAsked: 1 };
    await h.deps.sessions.save(spent);

    const result = await runAndCommit(spent, { trigger: 'initial', sourceIds: [sourceId] }, h.deps);

    expect(result.session.status).toBe('exhausted');
    // Running out of questions must never manufacture sufficiency.
    expect(result.turn.verdict.sufficient).toBe(false);
    expect(result.turn.verdict.budgetExhausted).toBe(true);
    expect(result.questions).toHaveLength(0);
    expect(h.generator.callsFor('generate-questions')).toHaveLength(0);
  });

  it('caps questions per turn so a round stays answerable', async () => {
    const many = {
      questions: Array.from({ length: 6 }, (_, i) => ({
        gapId: i % 2 === 0 ? 'gap-1' : 'gap-2',
        text: `Question ${i}?`,
        mode: 'single',
        options: [{ label: 'A' }, { label: 'B' }],
      })),
    };
    const h = harness('separate', {
      analyze: [TURN_1_DELTA],
      assess: [TURN_1_ASSESSMENT],
      'generate-questions': [many],
    });
    const { session, sourceId } = await seedSession(h);

    const result = await runAndCommit(
      session,
      { trigger: 'initial', sourceIds: [sourceId] },
      h.deps,
    );

    expect(result.questions).toHaveLength(4);
    expect(result.session.questionsAsked).toBe(4);
  });

  it('drops questions aimed at gaps that do not exist', async () => {
    const h = harness('separate', {
      analyze: [TURN_1_DELTA],
      assess: [TURN_1_ASSESSMENT],
      'generate-questions': [
        {
          questions: [
            { gapId: 'gap-99', text: 'Invented gap?', mode: 'single', options: [] },
            { gapId: 'gap-1', text: 'Real gap?', mode: 'single', options: [] },
          ],
        },
      ],
    });
    const { session, sourceId } = await seedSession(h);

    const result = await runAndCommit(
      session,
      { trigger: 'initial', sourceIds: [sourceId] },
      h.deps,
    );

    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]?.gapId).toBe('gap-1');
  });
});

describe('turn strategies', () => {
  it('reach the same outcome, which is what makes the config switch safe to flip', async () => {
    const outcomes = [];

    for (const strategy of ['separate', 'merged'] as const) {
      const h = harness(strategy);
      const { session, sourceId } = await seedSession(h);

      const first = await runAndCommit(
        session,
        { trigger: 'initial', sourceIds: [sourceId] },
        h.deps,
      );
      const second = await runAndCommit(
        first.session,
        { trigger: 'answers-received', answers: answerAll(first.questions) },
        h.deps,
      );

      outcomes.push({
        strategy,
        status: second.session.status,
        requirements: second.revision.content.requirements.map((r) => r.statement),
        resolved: second.revision.content.resolvedGaps.length,
        questionsAsked: second.session.questionsAsked,
        inputTokens: h.generator.totals().inputTokens,
        modelCalls: h.generator.calls.length,
      });
    }

    const [separate, merged] = outcomes;

    expect(separate?.status).toBe('sufficient');
    expect(merged?.status).toBe(separate?.status);
    expect(merged?.requirements).toEqual(separate?.requirements);
    expect(merged?.resolved).toBe(separate?.resolved);
    expect(merged?.questionsAsked).toBe(separate?.questionsAsked);

    // The reason both exist: merged trades fidelity for tokens, and the
    // difference is measured here rather than asserted in a design document.
    expect(merged?.modelCalls).toBeLessThan(separate?.modelCalls ?? 0);
    expect(merged?.inputTokens).toBeLessThan(separate?.inputTokens ?? 0);
  });
});
