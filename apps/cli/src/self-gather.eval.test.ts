import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Answer, Question, Session } from '@requirely/core/domain';
import {
  anthropicStructuredGenerator,
  formatMetrics,
  recordingStructuredGenerator,
  sessionMetrics,
  withValidationRetry,
} from '@requirely/core/server';
import { describe, expect, it } from 'vitest';
import { type Reply, scriptedAsker } from './asker.ts';
import { addSource } from './commands/add.ts';
import { generateDocument } from './commands/generate.ts';
import { newSession, showStatus } from './commands/session.ts';
import { answerQuestions, runOneTurn } from './commands/turn.ts';
import { type CliRuntime, createCliRuntime } from './compose.ts';

/**
 * **Requirely gathers its own requirements.**
 *
 * The end-to-end smoke test this plan has named since Phase 0, and the first
 * output a human reads that a real model wrote. It feeds `requirely.md` — the
 * product spec, the actual source of truth for scope — through the whole
 * pipeline and writes an SRS.
 *
 * ## How it is run, and why in two passes
 *
 * Recording cassettes make the second pass nearly free, which is what lets a
 * *human* be in the loop without paying for the whole session twice:
 *
 * 1. `REQUIRELY_LIVE=1` with no answers file — records turn 1 and writes the
 *    questions to `self-gather/questions.json`. Three calls.
 * 2. A person reads them and writes `self-gather/answers.json`.
 * 3. `REQUIRELY_LIVE=1` again — turn 1 replays from cassettes at zero cost, and
 *    only the answered turn is paid for.
 *
 * Without that, iterating on the answers would cost a full session each time,
 * and the answers are exactly the part worth iterating on.
 *
 * ## What it does *not* claim
 *
 * A single run against one model is an existence proof, not a benchmark. It
 * shows the pipeline produces a coherent document from a real document; it says
 * nothing about how *good* the questions were, which is what the eval suite and
 * a second model are for.
 */

const LIVE = process.env.REQUIRELY_LIVE === '1';
const MODEL = process.env.REQUIRELY_LIVE_MODEL ?? 'claude-haiku-4-5';

const HERE = import.meta.dirname;
const REPO = join(HERE, '../../..');
const SPEC = join(REPO, 'requirely.md');
const CASSETTES = join(REPO, 'packages/core/cassettes/self-gather');
const WORK = join(REPO, 'packages/core/cassettes/self-gather-work');
const QUESTIONS_OUT = join(WORK, 'questions.json');
const ANSWERS_IN = join(WORK, 'answers.json');
const SRS_OUT = join(REPO, 'docs/self-gathered-srs.md');

const RUNNABLE = LIVE || existsSync(CASSETTES);

if (!RUNNABLE) {
  process.stdout.write(
    `\n[self-gather] SKIPPED — no cassettes under ${CASSETTES}\n` +
      '[self-gather] run with: REQUIRELY_LIVE=1 pnpm --filter @requirely/cli exec vitest run src/self-gather.eval.test.ts\n\n',
  );
}

/** What a person wrote in `answers.json`, keyed by the question's exact text. */
interface AuthoredAnswer {
  /** 0-based indexes into the question's own option list. */
  readonly pick?: number[];
  /** Prose, for what the options did not cover. Always permitted. */
  readonly write?: string;
}

function authoredAnswers(): Record<string, AuthoredAnswer> {
  if (!existsSync(ANSWERS_IN)) return {};
  return JSON.parse(readFileSync(ANSWERS_IN, 'utf8')) as Record<string, AuthoredAnswer>;
}

/**
 * Answers from the file when a person has written one, and otherwise says so in
 * prose rather than silently defaulting to the first option.
 *
 * Defaulting would quietly produce a document built on choices nobody made — and
 * would report 100% recommendation acceptance, which is the exact
 * fixture-shaped lie the eval design exists to avoid.
 */
function personAnswering(authored: Record<string, AuthoredAnswer>): (q: Question) => Reply {
  return (question) => {
    const written = authored[question.text];
    if (written === undefined) {
      return {
        selectedOptionIds: [],
        customText: 'No answer was authored for this question in this run.',
      };
    }
    return {
      selectedOptionIds: (written.pick ?? []).flatMap((index) => {
        const option = question.options[index];
        return option === undefined ? [] : [option.id as string];
      }),
      customText: written.write ?? null,
    };
  };
}

async function liveRuntime(): Promise<CliRuntime> {
  const runtime = await createCliRuntime({
    provider: 'anthropic',
    model: MODEL,
    storage: 'memory',
  });

  return {
    ...runtime,
    deps: {
      ...runtime.deps,
      // `recording(retry(real))`, in that order: the cassette stores what the
      // engine consumed, so a replay skips the retry ladder rather than
      // re-deciding it.
      generator: recordingStructuredGenerator(
        withValidationRetry(
          anthropicStructuredGenerator({
            apiKey: runtime.config.credentials.anthropic ?? 'replay-only',
            model: MODEL,
          }),
          { logger: runtime.logger },
        ),
        {
          cassetteDir: CASSETTES,
          model: MODEL,
          mode: LIVE ? 'auto' : 'replay',
          logger: runtime.logger,
        },
      ),
    },
  };
}

const write = (path: string, body: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
};

describe.skipIf(!RUNNABLE)(`Requirely gathers its own requirements (${MODEL})`, () => {
  it('reads requirely.md, asks about it, and writes an SRS', { timeout: 900_000 }, async () => {
    const runtime = await liveRuntime();
    const [created] = await newSession(runtime, { title: 'Requirely' });
    const id = /Created (\S+)/.exec(created ?? '')?.[1];
    expect(id).toBeDefined();
    if (id === undefined) return;

    await addSource(runtime, id, SPEC, { label: 'requirely.md — the product spec' });

    const turn1 = await runOneTurn(runtime, id);
    console.info(turn1.join('\n'));

    const asked = await runtime.stores.inquiry.listUnansweredQuestions(
      (await runtime.stores.sessions.listRecent(1))[0]?.id ?? ('' as never),
    );

    // Dumped verbatim so a person can answer them, and committed so the run is
    // reproducible by someone who was not here.
    write(
      QUESTIONS_OUT,
      `${JSON.stringify(
        asked.map((question) => ({
          text: question.text,
          rationale: question.rationale,
          dimension: question.dimension,
          mode: question.mode,
          recommends: question.options.findIndex((o) => o.id === question.recommends),
          because: question.because,
          options: question.options.map((o) => ({ label: o.label, means: o.means })),
        })),
        null,
        2,
      )}\n`,
    );

    const authored = authoredAnswers();
    console.info(
      `\n[self-gather] ${asked.length} question(s); ${Object.keys(authored).length} authored answer(s) available`,
    );

    // Loop until the session stops, or a cap. One answered turn is not the loop —
    // it is a single iteration of it, and the interesting behaviour (reaching
    // sufficiency, running out of budget, or stalling) only appears across
    // several.
    let session = (await runtime.stores.sessions.findById(id as Session['id'])) as Session;
    for (let round = 0; round < 4 && session.status === 'awaiting-answers'; round += 1) {
      const answered = await answerQuestions(runtime, id, scriptedAsker(personAnswering(authored)));
      console.info(answered.join('\n'));
      session = (await runtime.stores.sessions.findById(id as Session['id'])) as Session;
      console.info(`[self-gather] after round ${round + 1}: ${session.status}`);
    }

    console.info((await showStatus(runtime, id)).join('\n'));

    const finished =
      session.status === 'sufficient' ||
      session.status === 'exhausted' ||
      session.status === 'stalled';

    // Reported rather than asserted. Whether one document reaches sufficiency
    // is a fact about the model and the spec, not about the pipeline — and a
    // test that demanded it would fail for the wrong reason.
    console.info(`\n[self-gather] final status: ${session.status}`);

    if (finished) {
      const [document] = await generateDocument(runtime, id, { target: 'srs' });
      write(SRS_OUT, document ?? '');
      console.info(`[self-gather] wrote ${SRS_OUT} (${(document ?? '').length} chars)`);
    }

    const metrics = sessionMetrics({
      session,
      turns: await runtime.stores.sessions.listTurns(session.id),
      questions: await runtime.stores.inquiry.listQuestions(session.id),
      answers: (await runtime.stores.inquiry.listAnswers(session.id)) as Answer[],
      understanding:
        (await runtime.stores.understanding.findLatest(session.id))?.content ??
        (undefined as never),
    });
    console.info(formatMetrics('[self-gather]', metrics));

    // The one thing this genuinely proves: the whole pipeline ran against a
    // real model and produced something.
    expect(metrics.calls).toBeGreaterThan(0);
    await runtime.close();
  });
});
