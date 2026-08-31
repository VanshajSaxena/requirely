import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { anthropicStructuredGenerator } from '../adapters/ai/anthropic.ts';
import { isPriced } from '../adapters/ai/pricing.ts';
import { recordingStructuredGenerator } from '../adapters/ai/recording.ts';
import { withValidationRetry } from '../adapters/ai/retry.ts';
import { inMemoryStores } from '../adapters/storage/memory.ts';
import { loadEnvFile } from '../config/env.ts';
import {
  createSession,
  DEFAULT_SUFFICIENCY_POLICY,
  type Session,
  sumUsage,
  type TurnCommit,
  type Usage,
} from '../domain/index.ts';
import { fixedClock, sequentialIdGenerator } from '../domain/testing/fakes.ts';
import { type EngineDeps, runTurn, type TurnRequest } from '../engine/loop.ts';
import { STRATEGIES } from '../engine/strategies.ts';
import { ingestText } from '../ingestion/text.ts';
import { recordingLogger } from '../observability/logger.ts';
import { answerAll, SOURCE_TEXT } from './scenario.ts';

/**
 * The engine against a **real provider**. One file, two modes.
 *
 * ## Why this exists rather than "just run the CLI once"
 *
 * A validator and a front door want opposite things. A validator should be
 * scripted, deterministic and cheap to re-run; a CLI should be forgiving and
 * interactive. Making one artifact do both means every iteration on argument
 * parsing or prompt UX costs another live session — and when something breaks
 * you cannot tell whether the engine or the CLI did it.
 *
 * Splitting them makes the model-facing cost **fixed and paid once**, and makes
 * every later CLI failure unambiguously a CLI failure.
 *
 * ## The two modes
 *
 * | Mode | Trigger | Cost | What it proves |
 * | --- | --- | --- | --- |
 * | record | `REQUIRELY_LIVE=1` | real | the engine works against a live provider |
 * | replay | default, cassettes present | $0 | recorded output still parses against the **current** schemas |
 *
 * That second row is a regression class the repo could not previously detect:
 * change a prompt or a draft schema and nothing noticed that yesterday's model
 * output no longer validates. `recording.ts` re-parses every replayed value, so
 * with cassettes committed `pnpm test` catches it for free.
 *
 * ## Two things that look like test conveniences and are not
 *
 * **`fixedClock` + `sequentialIdGenerator`, even though the model is real.**
 * Cassette identity is a hash of `(model, operation, instructions, input)`. If
 * anything non-deterministic reached the model's input the key would change on
 * every run, every replay would miss, and the cassettes would be write-only.
 * Determinism here is what makes them worth committing.
 *
 * **`recording(retry(real))`, in that order.** The cassette then stores what the
 * engine actually consumed — the value that finally validated — rather than a
 * failed attempt. The reverse order would re-request through the recorder on
 * each retry, minting a new cassette key per attempt and paying for all of them.
 */

const LIVE = process.env.REQUIRELY_LIVE === '1';
/**
 * Deliberately its own variable, not `REQUIRELY_REASONING_MODEL`.
 *
 * The harness wants the cheapest model that can exercise the loop; the app wants
 * the best one it can afford. Sharing a variable would also create an ordering
 * trap: `.env` is loaded inside `harness()`, after this line runs, so reading the
 * app's setting here would silently honour it in some run orders and not others.
 */
const MODEL = process.env.REQUIRELY_LIVE_MODEL ?? 'claude-haiku-4-5';
const CASSETTES = join(import.meta.dirname, '../../cassettes/live');
const REPO_ENV = join(import.meta.dirname, '../../../../.env');

/**
 * Cassettes are matched on a hash, so the filename cannot say which model
 * recorded them — the body can. Reading it is what stops a replay of one
 * model's session from silently standing in for another's.
 */
function hasCassettesFor(model: string): boolean {
  try {
    return readdirSync(CASSETTES).some(
      (file) =>
        file.endsWith('.json') &&
        (JSON.parse(readFileSync(join(CASSETTES, file), 'utf8')) as { model?: string }).model ===
          model,
    );
  } catch {
    return false;
  }
}

/**
 * **This guard answers "was anything ever recorded?", not "is it still valid?"**
 *
 * The cassette key is a hash of `(operation, instructions, input)`, so changing a
 * prompt or a schema does not invalidate a cassette — it *orphans* it, and the
 * next replay throws `no cassette at …` from inside the run rather than skipping
 * here. That happened for real when Phase 8 reshaped the domain: the Phase 7
 * recordings were still present and still named the right model, so this returned
 * true and the failure surfaced three calls deep.
 *
 * The fix when it happens is to delete the orphans, not to widen this check: a
 * cassette recorded against a schema that no longer exists is evidence for a
 * claim that is no longer being made. Deleting them makes the skip honest again.
 */
const RUNNABLE = LIVE || hasCassettesFor(MODEL);

if (!RUNNABLE) {
  // A silent skip reads like a pass. This is the loud version — the suite still
  // goes green, which is correct (nothing is broken), but the output says why.
  // `process.stderr` rather than `console.warn`: vitest buffers console output
  // per test and prints nothing for a file where no test ran, which is exactly
  // the case this message exists for.
  process.stderr.write(
    `\n[live] SKIPPED — no cassettes for "${MODEL}" under ${CASSETTES}\n` +
      '[live] record with: REQUIRELY_LIVE=1 pnpm --filter @requirely/core exec vitest run src/integration/live.test.ts\n\n',
  );
}

/** A line per operation, so a live run reports rather than merely asserts. */
function report(label: string, usage: readonly Usage[], retries: number): void {
  const total = sumUsage(usage);
  const cost =
    total.costMinorUnits === null
      ? `cost unknown (${MODEL} is not in the price table)`
      : `$${(total.costMinorUnits / 100).toFixed(4)}`;

  const perOperation = usage
    .map((u) => `${u.operation ?? 'unnamed'} ${u.inputTokens}in/${u.outputTokens}out`)
    .join('  ');

  console.info(
    `[live] ${label}: ${perOperation}\n` +
      `[live] ${label}: ${total.inputTokens} in / ${total.outputTokens} out · ${cost} · ${retries} schema retr${retries === 1 ? 'y' : 'ies'}`,
  );
}

describe.skipIf(!RUNNABLE)(`the engine against ${MODEL} (${LIVE ? 'RECORDING' : 'replay'})`, () => {
  const logger = recordingLogger();

  function harness() {
    if (LIVE) loadEnvFile(REPO_ENV);
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (LIVE && (apiKey === undefined || apiKey === '')) {
      // Only fail in record mode: replay needs no key, and demanding one would
      // make CI depend on a secret it never uses.
      throw new Error(`REQUIRELY_LIVE=1 but no ANTHROPIC_API_KEY (looked in ${REPO_ENV})`);
    }

    const stores = inMemoryStores();
    const deps: EngineDeps = {
      generator: recordingStructuredGenerator(
        withValidationRetry(
          anthropicStructuredGenerator({ apiKey: apiKey ?? 'replay-only', model: MODEL }),
          { logger },
        ),
        { cassetteDir: CASSETTES, model: MODEL, mode: LIVE ? 'auto' : 'replay', logger },
      ),
      sessions: stores.sessions,
      sources: stores.sources,
      revisions: stores.understanding,
      inquiry: stores.inquiry,
      clock: fixedClock('2026-01-01T00:00:00.000Z'),
      ids: sequentialIdGenerator(),
      policy: DEFAULT_SUFFICIENCY_POLICY,
      strategy: STRATEGIES.separate,
      maxQuestionsPerTurn: 4,
    };
    return { deps, stores };
  }

  const retriesSoFar = (): number =>
    logger.entries.filter((e) => e.message === 'model output failed schema validation').length;

  async function runAndCommit(
    session: Session,
    request: TurnRequest,
    h: ReturnType<typeof harness>,
  ): Promise<TurnCommit> {
    const commit = await runTurn(session, request, h.deps);
    await h.stores.committer.commit(commit);
    return commit;
  }

  it('ingests, analyses, asks, answers and re-evaluates — end to end, real model', {
    timeout: 180_000,
  }, async () => {
    const h = harness();
    const session = createSession({ questionBudget: 12, title: 'Requirely' }, h.deps);
    await h.deps.sessions.create(session);

    const source = ingestText(
      { sessionId: session.id, label: 'kickoff notes', text: SOURCE_TEXT, ordinal: 1 },
      h.deps,
    );
    await h.deps.sources.add(source);

    // ---------------------------------------------------------------- turn 1
    const before = retriesSoFar();
    const first = await runAndCommit(session, { trigger: 'initial', sourceIds: [source.id] }, h);
    report('turn 1', first.turn.usage, retriesSoFar() - before);

    // Shape, not content: a real model will not reproduce a fixture, so every
    // assertion here has to hold for any competent answer.
    // Revisions are 0-indexed: the first turn produces revision 0. Asserted
    // rather than assumed — getting this wrong is how a harness starts
    // reporting a working engine as broken.
    expect(first.revision.revision).toBe(0);
    expect(first.turn.index).toBe(first.revision.revision);
    const understanding = first.revision.content;
    expect(
      understanding.requirements.length +
        understanding.constraints.length +
        understanding.decisions.length,
      'the model produced nothing at all from a product brief',
    ).toBeGreaterThan(0);
    expect(['awaiting-answers', 'sufficient', 'exhausted']).toContain(first.session.status);

    // The Phase 3b question, answered by arriving here at all. `applyDelta`
    // throws `UnknownReferenceError` on an id it does not recognise, so a
    // committed turn is proof the model copied `src-1` back verbatim — the
    // whole reason 40-character UUIDs were replaced with short scoped ids.
    const cited = understanding.requirements.flatMap((r) => r.provenance.map((p) => p.sourceId));
    expect(cited.every((id) => id === source.id)).toBe(true);

    console.info(
      `[live] turn 1: ${understanding.decisions.length} decisions, ` +
        `${understanding.requirements.length} open requirements, ` +
        `${first.questions.length} questions, ` +
        `verdict sufficient=${first.turn.verdict.sufficient}`,
    );

    // ---------------------------------------------------------------- turn 2
    if (first.session.status !== 'awaiting-answers') {
      // Reaching sufficiency in one turn is a legitimate outcome, not a
      // failure — say so rather than forcing a second paid turn.
      console.info('[live] reached a verdict in one turn; no answers to give');
      return;
    }

    expect(first.questions.length).toBeGreaterThan(0);
    for (const question of first.questions) {
      // The spec's answer contract: every question takes a custom answer, and
      // a one-option list is a false choice.
      expect(question.allowsCustom).toBe(true);
      expect(question.options.length === 0 || question.options.length >= 2).toBe(true);
    }

    const beforeTurn2 = retriesSoFar();
    const second = await runAndCommit(
      first.session,
      { trigger: 'answers-received', answers: answerAll(first.questions) },
      h,
    );
    report('turn 2', second.turn.usage, retriesSoFar() - beforeTurn2);

    expect(second.revision.revision).toBe(1);
    expect(second.turn.index).toBe(second.revision.revision);

    const all = [...first.turn.usage, ...second.turn.usage];
    const total = sumUsage(all);
    expect(total.inputTokens).toBeGreaterThan(0);
    expect(total.outputTokens).toBeGreaterThan(0);
    // A model in the price table must produce a cost; the null path is for
    // models the table does not know, and this one it does.
    if (isPriced(MODEL)) expect(total.costMinorUnits).not.toBeNull();

    const cost =
      total.costMinorUnits === null ? 'unknown' : `$${(total.costMinorUnits / 100).toFixed(4)}`;
    console.info(
      `[live] session total: ${total.inputTokens} in / ${total.outputTokens} out · ${cost} · ` +
        `${retriesSoFar()} schema retries across ${all.length} calls · ` +
        `final status ${second.session.status}`,
    );
  });
});
