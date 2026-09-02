import { describe, expect, it } from 'vitest';
import { anthropicStructuredGenerator } from '../adapters/ai/anthropic.ts';
import { fakeStructuredGenerator } from '../adapters/ai/fake.ts';
import { type CallMeter, createCallMeter, withMetering } from '../adapters/ai/metering.ts';
import { recordingStructuredGenerator } from '../adapters/ai/recording.ts';
import { withValidationRetry } from '../adapters/ai/retry.ts';
import { inMemoryStores } from '../adapters/storage/memory.ts';
import { loadEnvFile } from '../config/env.ts';
import {
  createSession,
  DEFAULT_SUFFICIENCY_POLICY,
  emptyUnderstanding,
  type StructuredGenerator,
} from '../domain/index.ts';
import { fixedClock, sequentialIdGenerator } from '../domain/testing/fakes.ts';
import { type EngineDeps, runTurn } from '../engine/loop.ts';
import { STRATEGIES, type StrategyName } from '../engine/strategies.ts';
import { ingestText } from '../ingestion/text.ts';
import { recordingLogger } from '../observability/logger.ts';
import {
  formatMetrics,
  type SessionMetrics,
  sessionMetrics,
} from '../observability/session-metrics.ts';
import { announceSkip, cassettesFor, LIVE, MODEL, REPO_ENV, runnableFor } from './live-harness.ts';
import { answerAll, SOURCE_TEXT, scriptFor } from './scenario.ts';

/**
 * Which configuration is better, measured rather than argued.
 *
 * `live.test.ts` asks *does the engine work against a real provider*.
 * This asks *which way of running it is better*, and it is the file that turns
 * "one call or three?" and "constrained or prompted?" into numbers — the same
 * way `text` → `timestamptz` and UUID → short-id were settled.
 *
 * ## The honest split, and why the file is shaped this way
 *
 * **An eval run against a fake measures the fixture, not the model.** A scripted
 * fake always picks option zero, so it would report 100% recommendation
 * acceptance — a fact about `answerAll` and nothing whatever about anchoring.
 * Publishing that number as an anchoring finding would be worse than publishing
 * nothing.
 *
 * So the file has two halves that claim different things:
 *
 * | Half | Runs | Claims |
 * | --- | --- | --- |
 * | **the instrument** | always, on the fake | the harness runs a session and the arithmetic holds |
 * | **the readings** | `REQUIRELY_LIVE=1`, or replay from cassettes | what a real model actually does |
 *
 * The arithmetic itself is pinned separately in
 * `observability/session-metrics.test.ts`, without a model at all. That
 * separation is deliberate: the readings need a provider, and the instrument
 * must not, or every number it later produces is unverifiable.
 *
 * **The readings half is currently unavailable** — the org API spend limit
 * blocked recording, so it skips loudly rather than passing vacuously. Nothing
 * about generation *method* has been measured against a real model yet.
 */

const AT = '2026-01-01T00:00:00.000Z';

interface RunResult {
  readonly metrics: SessionMetrics;
  readonly retries: number;
}

/**
 * Runs the two-turn fixture session to completion and measures it.
 *
 * Everything the metrics need is read back from the stores after the fact, not
 * accumulated as the run goes: a measurement taken from what was *persisted* is
 * a measurement of what a resumed session would also see.
 */
async function runSession(
  strategy: StrategyName,
  generatorFor: (logger: ReturnType<typeof recordingLogger>) => StructuredGenerator,
  meter?: CallMeter,
): Promise<RunResult> {
  const logger = recordingLogger();
  const stores = inMemoryStores();
  const base = generatorFor(logger);

  const deps: EngineDeps = {
    generator: meter === undefined ? base : withMetering(base, meter),
    sessions: stores.sessions,
    sources: stores.sources,
    revisions: stores.understanding,
    inquiry: stores.inquiry,
    clock: fixedClock(AT),
    ids: sequentialIdGenerator(),
    policy: DEFAULT_SUFFICIENCY_POLICY,
    strategy: STRATEGIES[strategy],
    maxQuestionsPerTurn: 4,
  };

  let session = createSession({ questionBudget: 12, title: 'eval' }, deps);
  await stores.sessions.create(session);

  const source = await ingestText(
    { sessionId: session.id, label: 'brief', text: SOURCE_TEXT, ordinal: 1 },
    deps,
  );
  await stores.sources.add(source);

  let commit = await runTurn(session, { trigger: 'initial', sourceIds: [source.id] }, deps);
  await stores.committer.commit(commit);
  session = commit.session;

  let turn = 1;
  // Bounded so a stalled or looping configuration ends the eval rather than the
  // process. Five is well past the fixture's two and well short of a hang.
  while (session.status === 'awaiting-answers' && turn < 5) {
    turn += 1;
    const pending = await stores.inquiry.listUnansweredQuestions(session.id);
    commit = await runTurn(
      session,
      { trigger: 'answers-received', answers: answerAll(pending, turn) },
      deps,
    );
    await stores.committer.commit(commit);
    session = commit.session;
  }

  const revision = await stores.understanding.findLatest(session.id);

  return {
    metrics: sessionMetrics({
      session,
      turns: await stores.sessions.listTurns(session.id),
      questions: await stores.inquiry.listQuestions(session.id),
      answers: await stores.inquiry.listAnswers(session.id),
      understanding: revision?.content ?? emptyUnderstanding(),
      ...(meter === undefined
        ? {}
        : { repairsPerCall: meter.calls.map((call) => call.repairs.length) }),
    }),
    retries: logger.entries.filter((e) => e.message === 'model output failed schema validation')
      .length,
  };
}

describe('the instrument — runs on scripted responses, claims nothing about a model', () => {
  const onFake = (strategy: StrategyName, meter?: CallMeter) =>
    runSession(strategy, () => fakeStructuredGenerator(scriptFor(strategy)), meter);

  it('measures a whole session end to end from what was persisted', async () => {
    const { metrics } = await onFake('separate');

    expect(metrics.finalStatus).toBe('sufficient');
    expect(metrics.turnsToSufficient).toBe(2);
    expect(metrics.calls).toBe(5);
    expect(metrics.usage.inputTokens).toBeGreaterThan(0);
    expect(metrics.settledRatio).toBe(1);
  });

  it('separates the two strategies by cost while holding the outcome equal', async () => {
    // The real reason both exist, and the only honest thing the fake can settle:
    // `merged` folds analyze and assess into one call, so it sends the
    // understanding once. That is a property of the *engine*, not of a model, so
    // a scripted run measures it truthfully.
    const separate = await onFake('separate');
    const merged = await onFake('merged');

    console.info(formatMetrics('separate', separate.metrics));
    console.info(formatMetrics('merged  ', merged.metrics));

    expect(merged.metrics.finalStatus).toBe(separate.metrics.finalStatus);
    expect(merged.metrics.turnsToSufficient).toBe(separate.metrics.turnsToSufficient);
    expect(merged.metrics.settledRatio).toBe(separate.metrics.settledRatio);

    expect(merged.metrics.calls).toBeLessThan(separate.metrics.calls);
    expect(merged.metrics.usage.inputTokens).toBeLessThan(separate.metrics.usage.inputTokens);
  });

  it('reports repairs as a number once something is metering them', async () => {
    const withMeter = await onFake('separate', createCallMeter());
    const without = await onFake('separate');

    expect(withMeter.metrics.repairs).toBe(0);
    // Null, not zero: an unmetered run has no opinion about repairs and must not
    // claim there were none.
    expect(without.metrics.repairs).toBeNull();
  });

  it('reads the anchoring instrument, and the reading is about the fixture', async () => {
    // Asserted *and* labelled. `answerAll` picks option zero and the fixture
    // recommends index zero, so 100% here is arithmetic, not evidence. The test
    // exists so a future change to either half is visible; the number means
    // nothing until a person is answering.
    const { metrics } = await onFake('separate');

    expect(metrics.recommendationsOffered).toBe(1);
    expect(metrics.recommendationAcceptance).toBe(1);
  });

  it('reads the assumption instrument on a session that made none', async () => {
    // A zero that is worth pinning: the fixture settles everything without
    // inferring anything, so a future prompt change that starts producing
    // assumptions shows up here as a regression rather than as nothing.
    const { metrics } = await onFake('separate');

    expect(metrics.assumptionsMade).toBe(0);
    expect(metrics.assumptionsPerTurn).toBe(0);
  });
});

/**
 * Its own cassette directory, not the live suite's.
 *
 * These two tests drive *different* sessions, so a shared directory would let
 * this one's guard pass on the other one's recordings and then fail three calls
 * deep. One directory per suite makes "can this run?" and "does this have what
 * it needs?" the same question.
 */
const EVAL_CASSETTES = cassettesFor('eval');
const EVAL_RUNNABLE = runnableFor(EVAL_CASSETTES);

if (!EVAL_RUNNABLE) announceSkip('eval', EVAL_CASSETTES);

describe.skipIf(!EVAL_RUNNABLE)(
  `the readings — ${MODEL} (${LIVE ? 'RECORDING' : 'replay'})`,
  () => {
    loadEnvFile(REPO_ENV);
    const apiKey = process.env.ANTHROPIC_API_KEY;

    /**
     * `recording(metering(retry(real)))`.
     *
     * The meter sits *inside* the recorder so a replay does not re-record, and
     * *outside* retry so one logical call is one entry with wasted attempts
     * already folded into its usage.
     */
    const liveGenerator = (meter: CallMeter) => (logger: ReturnType<typeof recordingLogger>) =>
      recordingStructuredGenerator(
        withMetering(
          withValidationRetry(
            anthropicStructuredGenerator({ apiKey: apiKey ?? 'replay-only', model: MODEL }),
            { logger },
          ),
          meter,
        ),
        { cassetteDir: EVAL_CASSETTES, model: MODEL, mode: LIVE ? 'auto' : 'replay', logger },
      );

    it('compares both strategies against a real model', async () => {
      const results: { strategy: StrategyName; run: RunResult; meter: CallMeter }[] = [];

      for (const strategy of ['separate', 'merged'] as const) {
        const meter = createCallMeter();
        results.push({
          strategy,
          run: await runSession(strategy, liveGenerator(meter), meter),
          meter,
        });
      }

      for (const { strategy, run, meter } of results) {
        console.info(formatMetrics(strategy.padEnd(8), run.metrics));
        console.info(
          `${strategy.padEnd(8)}: methods ${[...new Set(meter.calls.map((c) => c.method))].join(', ')} · ${run.retries} schema retr${run.retries === 1 ? 'y' : 'ies'}`,
        );
      }

      // Asserted loosely on purpose. The point of this test is the *report*: which
      // configuration is cheaper is a measurement, and pinning an expected number
      // would turn a finding into a fixture the moment a model changed.
      for (const { run } of results) {
        expect(run.metrics.turns).toBeGreaterThan(0);
        expect(run.metrics.calls).toBeGreaterThan(0);
      }

      const [separate, merged] = results;
      expect(merged?.run.metrics.calls).toBeLessThanOrEqual(separate?.run.metrics.calls ?? 0);
    });
  },
);
