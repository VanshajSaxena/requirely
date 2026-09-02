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
import {
  answerAll,
  coverage,
  SOURCE_TEXT,
  scriptFor,
  TURN_1_ASSESSMENT,
  TURN_1_DELTA,
  TURN_1_QUESTIONS,
} from './scenario.ts';

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

describe('every model call carries a spend ceiling', () => {
  it('sends maxOutputTokens on every operation, so a turn has a knowable worst case', async () => {
    // Not a tuning assertion — a cost one. With `maxOutputTokens` unset the SDK
    // falls back to the model's own maximum *and* derives the extended-thinking
    // budget from it, so an uncapped turn on claude-opus-5 was bounded only by
    // ~$4.80. Discovered from a live request that failed on auth and so cost
    // nothing; pinned here so it cannot come back silently.
    const h = harness();
    const { session, sourceId } = await seedSession(h);
    await runAndCommit(session, { trigger: 'initial', sourceIds: [sourceId] }, h.deps);

    expect(h.generator.calls.length).toBeGreaterThan(0);
    for (const call of h.generator.calls) {
      expect(call.maxOutputTokens, `${call.operation} went out uncapped`).toBeGreaterThan(0);
      // A ceiling above any real model's output limit would be a cap in name only.
      expect(call.maxOutputTokens ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(32_000);
    }
  });
});

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
    expect(result.revision.content.requirements).toHaveLength(2);
    expect(result.revision.content.constraints).toHaveLength(1);
    expect(result.revision.content.decisions).toHaveLength(0);
    expect(result.questions).toHaveLength(2);
    expect(result.session.questionsAsked).toBe(2);

    // The verdict is recorded and readable, not merely computed. On turn 1
    // nothing is settled, so *every* required dimension is a shortfall — the
    // structural signal, ordered by the model's scores inside it.
    expect(result.turn.verdict.sufficient).toBe(false);
    expect(result.turn.verdict.shortfalls).toEqual([
      'acceptance',
      'users',
      'purpose',
      'core-behaviour',
      'constraints',
    ]);
    expect(result.turn.verdict.rationale).toContain('nothing settled yet for');
    expect(result.turn.verdict.settled).toMatchObject({ decisions: 0, open: 3, ratio: 0 });
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

  it('turn 2 folds answers in, promotes the answered items, and reaches sufficiency', async () => {
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

    // Every open item was promoted and two more decisions came straight from the
    // source, so nothing is left uncertain. This is the loop's whole job.
    expect(second.revision.content.decisions).toHaveLength(5);
    expect(second.revision.content.requirements).toHaveLength(0);
    expect(second.revision.content.constraints).toHaveLength(0);
    expect(second.turn.verdict.settled).toMatchObject({ decisions: 5, open: 0, ratio: 1 });

    // `settledBy` is the engine's derived AnswerId, never a model transcription.
    expect(second.revision.content.decisions[0]?.settledBy).toBe(second.turn.inputAnswerIds[0]);
    expect(second.revision.content.decisions[0]?.promotedFrom).toBe('req-2');
    // And the source-settled ones name a real source, validated by applyDelta.
    expect(second.revision.content.decisions[2]?.settledBy).toBe('src-1');
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

  it('lands in stalled, not exhausted, when turns stop settling anything', async () => {
    // Three turns that add nothing new. The first two are ordinary — a turn
    // spent ingesting legitimately settles nothing — and the third crosses the
    // policy's patience. Distinct from `exhausted` on purpose: one says "give me
    // a bigger budget", this one says "the questions are not landing".
    const stuck = { ...TURN_1_ASSESSMENT, coverage: coverage(0.2) };
    const nothing = { product: TURN_1_DELTA.product, ops: [] };
    const questions = {
      questions: [
        {
          dimension: 'purpose',
          text: 'What is this for?',
          rationale: 'scripted',
          mode: 'single',
          options: [
            { label: 'A', commits: 'a' },
            { label: 'B', commits: 'b' },
          ],
        },
      ],
    };

    const h = harness('separate', {
      analyze: [TURN_1_DELTA, nothing, nothing],
      assess: [TURN_1_ASSESSMENT, stuck, stuck],
      'generate-questions': [questions, questions, questions],
    });
    const { session, sourceId } = await seedSession(h, 12);

    let current = await runAndCommit(
      session,
      { trigger: 'initial', sourceIds: [sourceId] },
      h.deps,
    );
    expect(current.turn.verdict.turnsWithoutProgress).toBe(0);

    current = await runAndCommit(
      current.session,
      { trigger: 'answers-received', answers: answerAll(current.questions, 2) },
      h.deps,
    );
    // One quiet turn is noise, not a stall.
    expect(current.turn.verdict.turnsWithoutProgress).toBe(1);
    expect(current.session.status).toBe('awaiting-answers');

    current = await runAndCommit(
      current.session,
      { trigger: 'answers-received', answers: answerAll(current.questions, 3) },
      h.deps,
    );

    expect(current.turn.verdict.turnsWithoutProgress).toBe(2);
    expect(current.turn.verdict.stalled).toBe(true);
    expect(current.session.status).toBe('stalled');
    // Stalling is not sufficiency, and there is budget left — that is the whole
    // distinction. Conflating the two would tell the user the wrong thing to do.
    expect(current.turn.verdict.sufficient).toBe(false);
    expect(current.turn.verdict.budgetExhausted).toBe(false);
  });

  it('carries the stall counter across a full stop and restart', async () => {
    // The counter lives on the previous turn's verdict, not in memory, so a
    // resumed session picks the trajectory back up rather than starting over.
    const stuck = { ...TURN_1_ASSESSMENT, coverage: coverage(0.2) };
    const nothing = { product: TURN_1_DELTA.product, ops: [] };
    const h = harness('separate', {
      analyze: [TURN_1_DELTA, nothing],
      assess: [TURN_1_ASSESSMENT, stuck],
      'generate-questions': [TURN_1_QUESTIONS, TURN_1_QUESTIONS],
    });
    const { session, sourceId } = await seedSession(h, 12);

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

    // Read back from storage rather than from the returned object, which is the
    // only version of this assertion a resumed process could make.
    const stored = await h.deps.sessions.listTurns(session.id);
    expect(stored.at(-1)?.verdict.turnsWithoutProgress).toBe(1);
    expect(second.turn.verdict.settled.decisions).toBe(0);
  });

  it('caps questions per turn so a round stays answerable', async () => {
    const many = {
      questions: Array.from({ length: 6 }, (_, i) => ({
        dimension: i % 2 === 0 ? 'acceptance' : 'users',
        text: `Question ${i}?`,
        rationale: 'scripted',
        mode: 'single',
        options: [
          { label: 'A', commits: 'commits to A' },
          { label: 'B', commits: 'commits to B' },
        ],
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

  it('keeps a question whose `about` names nothing, clearing the stale pointer', async () => {
    // Before the redesign this question was *dropped*, because a question had to
    // name a live Gap. Dropping it is now the wrong move: the question is still
    // worth asking, it simply no longer settles that particular item.
    const h = harness('separate', {
      analyze: [TURN_1_DELTA],
      assess: [TURN_1_ASSESSMENT],
      'generate-questions': [
        {
          questions: [
            {
              dimension: 'acceptance',
              about: 'req-99',
              text: 'Invented target?',
              rationale: 'scripted',
              mode: 'single',
              options: [],
            },
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
    expect(result.questions[0]?.about).toBeNull();
    expect(result.questions[0]?.dimension).toBe('acceptance');
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
        decisions: second.revision.content.decisions.map((d) => d.statement),
        questionsAsked: second.session.questionsAsked,
        inputTokens: h.generator.totals().inputTokens,
        modelCalls: h.generator.calls.length,
      });
    }

    const [separate, merged] = outcomes;

    expect(separate?.status).toBe('sufficient');
    expect(merged?.status).toBe(separate?.status);
    expect(merged?.requirements).toEqual(separate?.requirements);
    expect(merged?.decisions).toEqual(separate?.decisions);
    expect(merged?.questionsAsked).toBe(separate?.questionsAsked);

    // The reason both exist: merged trades fidelity for tokens, and the
    // difference is measured here rather than asserted in a design document.
    expect(merged?.modelCalls).toBeLessThan(separate?.modelCalls ?? 0);
    expect(merged?.inputTokens).toBeLessThan(separate?.inputTokens ?? 0);
  });
});
