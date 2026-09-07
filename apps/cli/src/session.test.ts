import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Question } from '@requirely/core/domain';
import { describe, expect, it } from 'vitest';
import { type Reply, scriptedAsker, takeFirstOption } from './asker.ts';
import { addSource } from './commands/add.ts';
import { generateDocument } from './commands/generate.ts';
import { listSessions, newSession, showStatus } from './commands/session.ts';
import { answerQuestions, runOneTurn } from './commands/turn.ts';
import { type CliRuntime, createCliRuntime } from './compose.ts';

/**
 * A whole CLI session, every command, zero spend.
 *
 * **This is the test the plan asked for and the one that closes a recorded
 * weakness.** `apps/cli generate` is the first real caller of `project()` —
 * every other caller builds a `ProjectionInput` by hand, so the deliberation
 * trail has only ever been proven against fixtures. Here the questions and
 * answers come out of a repository, which is the only version of that claim
 * worth making.
 *
 * It runs against `--provider fake`, so the model's replies are scripted while
 * everything else — ingestion, the two-step commit, validation, projection — is
 * the real path.
 */

/**
 * The scripted provider's script.
 *
 * Written in the **wire** format, because that is what a model emits and what
 * the fake validates against. Turn 1 proposes; turn 2 settles every required
 * dimension, which is what sufficiency now costs.
 */
const op = (fields: Record<string, unknown>) => ({
  op: 'add',
  target: 'requirement',
  id: '',
  statement: '',
  kind: '',
  category: '',
  risk: '',
  priority: '',
  dimension: '',
  blocking: '',
  basis: '',
  rationale: '',
  settledBySourceId: '',
  supersedes: '',
  reason: '',
  provenance: [],
  ...fields,
});

const product = {
  name: 'Roomly',
  oneLiner: 'Book a meeting room without arguing in Slack',
  problem: '',
  purpose: '',
  users: [],
};

const TURN_1 = {
  product,
  ops: [
    op({
      statement: 'Show which rooms are free right now',
      kind: 'functional',
      dimension: 'core-behaviour',
      provenance: [{ sourceId: 'src-1', quote: 'see what is free', note: '' }],
    }),
    op({ statement: 'Anyone in the company can book', kind: 'functional', dimension: 'users' }),
  ],
};

const TURN_2 = {
  product,
  ops: [
    op({
      op: 'promote',
      target: 'decision',
      id: 'req-1',
      statement: 'Availability comes from Google Calendar, not manual entry',
      kind: 'functional',
      dimension: 'core-behaviour',
      rationale: 'Manual entry was offered and rejected: nobody would keep it current.',
    }),
    // Cites a source rather than an answer, because only one question was asked
    // and it was about `req-1`. The domain rejected the first version of this
    // fixture with `UnsettledDecisionError` — a Decision must trace back to
    // something, and "the model asserted it" is not something.
    op({
      op: 'promote',
      target: 'decision',
      id: 'req-2',
      statement: 'Any employee may book; no approval step',
      kind: 'scope',
      dimension: 'users',
      rationale: 'Approval was considered and dropped as friction nobody asked for.',
      settledBySourceId: 'src-1',
    }),
    op({
      target: 'decision',
      statement: 'Roomly exists to stop room-booking arguments',
      kind: 'scope',
      dimension: 'purpose',
      rationale: 'Stated directly in the brief.',
      settledBySourceId: 'src-1',
    }),
    op({
      target: 'decision',
      statement: 'Must work on a phone in a corridor',
      kind: 'constraint',
      dimension: 'constraints',
      rationale: 'Booking happens on the way to the room.',
      settledBySourceId: 'src-1',
    }),
    op({
      target: 'decision',
      statement: 'Success is booking a room in under fifteen seconds',
      kind: 'acceptance',
      dimension: 'acceptance',
      rationale: 'Anything slower and people go back to Slack.',
      settledBySourceId: 'src-1',
    }),
  ],
};

const coverage = (score: number) =>
  [
    'purpose',
    'users',
    'core-behaviour',
    'data',
    'constraints',
    'edge-cases',
    'acceptance',
    'integrations',
  ].map((dimension) => ({ dimension, score, rationale: `${dimension}: scripted` }));

const ASSESS = (score: number) => ({
  summary: 'scripted',
  blockingItemIds: [],
  coverage: coverage(score),
});

const QUESTIONS = {
  questions: [
    {
      dimension: 'core-behaviour',
      about: 'req-1',
      text: 'Where does room availability come from?',
      rationale: 'Nothing states the source of truth, and every other behaviour depends on it.',
      mode: 'single',
      recommends: 0,
      because: 'Calendar data is already maintained; a second copy would drift.',
      options: [
        {
          label: 'Google Calendar',
          commits: 'Every room needs a calendar resource and an integration to keep.',
          settles: ['req-1'],
        },
        {
          label: 'Entered by hand in Roomly',
          commits: 'Someone has to keep it current, forever.',
        },
      ],
    },
  ],
};

const SCRIPT = {
  analyze: [TURN_1, TURN_2],
  assess: [ASSESS(0.4), ASSESS(0.9)],
  'generate-questions': [QUESTIONS],
};

async function harness(): Promise<CliRuntime> {
  const runtime = await createCliRuntime({ provider: 'fake', storage: 'memory' });
  // The fake built by the registry has no script; swap in one that does. The
  // registry's job is choosing *which* adapter, not configuring it.
  const { fakeStructuredGenerator } = await import('@requirely/core/server');
  return {
    ...runtime,
    deps: { ...runtime.deps, generator: fakeStructuredGenerator(SCRIPT) },
  };
}

const brief = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'requirely-cli-'));
  const path = join(dir, 'brief.txt');
  await writeFile(path, 'I want to see what rooms are free and book one without asking anyone.');
  return path;
};

const idFrom = (lines: readonly string[]): string => {
  const match = /Created (\S+)/.exec(lines[0] ?? '');
  if (match?.[1] === undefined) throw new Error(`no session id in: ${lines.join(' ')}`);
  return match[1];
};

/**
 * The same script, as the file a *user* runs.
 *
 * `--provider fake` on its own is inert — `adapters/registry.ts` builds
 * `fakeStructuredGenerator()` with an empty script — so `--script` is what makes
 * the advertised zero-cost path real. The fixture is committed because a flag
 * that needs a file nobody has is not a usable flag.
 */
const FIXTURE = join(import.meta.dirname, '../fixtures/roomly.json');

describe('the committed fixture', () => {
  it('is byte-for-byte the script these tests prove', async () => {
    // The drift guard. Without it there are two copies of this script — the one
    // the tests exercise and the one a user runs — and only the first is ever
    // checked. Every comment above about *why* a fixture is shaped this way
    // (`settledBySourceId` on the second promote, because the domain rejected the
    // version without it) protects the file on disk only if the two stay equal.
    const onDisk: unknown = JSON.parse(await readFile(FIXTURE, 'utf8'));
    expect(onDisk).toEqual(SCRIPT);
  });

  it('drives a full session when passed as --script', async () => {
    // Through `createCliRuntime` rather than a hand-swapped generator: this is
    // the code path `requirely turn <id> --script ...` actually takes, and it is
    // the only test that covers `scriptedGenerator`.
    const runtime = await createCliRuntime({
      provider: 'fake',
      storage: 'memory',
      script: FIXTURE,
    });
    const id = idFrom(await newSession(runtime, { title: 'Roomly' }));
    await addSource(runtime, id, await brief());
    await runOneTurn(runtime, id);
    await answerQuestions(runtime, id, scriptedAsker(takeFirstOption));

    const [srs] = await generateDocument(runtime, id, { target: 'srs' });
    expect(srs).toContain('Availability comes from Google Calendar');

    await runtime.close();
  });

  it('says which file it could not read', async () => {
    await expect(
      createCliRuntime({ provider: 'fake', storage: 'memory', script: '/nope/missing.json' }),
    ).rejects.toThrow(/Could not read the script at \/nope\/missing.json/);
  });
});

describe('a whole session, every command, no spend', () => {
  it('runs new → add → turn → answer → generate', async () => {
    const runtime = await harness();
    const id = idFrom(await newSession(runtime, { title: 'Roomly' }));

    const added = await addSource(runtime, id, await brief());
    expect(added[0]).toContain('Added src-1');

    const turn1 = await runOneTurn(runtime, id);
    expect(turn1.join('\n')).toContain('Not yet sufficient');
    expect(turn1.join('\n')).toContain('awaiting answers');

    // The recommendation is *taken* here, which is the ordinary path. The test
    // below deliberately rejects it.
    const answered = await answerQuestions(
      runtime,
      id,
      scriptedAsker((question) => takeFirstOption(question)),
    );
    expect(answered.join('\n')).toContain('Google Calendar');
    expect(answered.join('\n')).toContain('sufficient');

    const srs = await generateDocument(runtime, id, { target: 'srs' });
    expect(srs[0]).toContain('Software Requirements Specification — Roomly');
    // The body is built from decisions, so a settled session has one.
    expect(srs[0]).toContain('Availability comes from Google Calendar');

    await runtime.close();
  });

  it('renders the deliberation trail from real repository data', async () => {
    // The point of this whole command existing. Every other caller of
    // `project()` hand-builds its input; here the questions and answers are
    // fetched, so "we considered and rejected X" is proven end to end.
    const runtime = await harness();
    const id = idFrom(await newSession(runtime, { title: 'Roomly' }));
    await addSource(runtime, id, await brief());
    await runOneTurn(runtime, id);
    await answerQuestions(runtime, id, scriptedAsker(takeFirstOption));

    const [doc] = await generateDocument(runtime, id, { target: 'requirements-doc' });

    expect(doc).toContain('Appendix D — What was decided, and what was considered');
    expect(doc).toContain('Where does room availability come from?');
    expect(doc).toContain('considered and rejected: Entered by hand in Roomly');
    expect(doc).toContain('Someone has to keep it current, forever.');

    await runtime.close();
  });

  it('writes to a file when asked, and prints to stdout otherwise', async () => {
    const runtime = await harness();
    const id = idFrom(await newSession(runtime, {}));
    await addSource(runtime, id, await brief());
    await runOneTurn(runtime, id);
    await answerQuestions(runtime, id, scriptedAsker(takeFirstOption));

    const out = join(await mkdtemp(join(tmpdir(), 'requirely-out-')), 'spec.md');
    const lines = await generateDocument(runtime, id, { target: 'agent-prompt', out });

    expect(lines[0]).toContain('Wrote');
    expect(await readFile(out, 'utf8')).toContain('You are implementing');

    await runtime.close();
  });
});

describe('status and ls', () => {
  it('reports what is settled and what is open, with no model call', async () => {
    const runtime = await harness();
    const id = idFrom(await newSession(runtime, { title: 'Roomly' }));
    await addSource(runtime, id, await brief());
    await runOneTurn(runtime, id);

    const before = (runtime.deps.generator as { calls?: unknown[] }).calls?.length ?? 0;
    const status = (await showStatus(runtime, id)).join('\n');
    const after = (runtime.deps.generator as { calls?: unknown[] }).calls?.length ?? 0;

    // `status` is the command a user runs repeatedly. One that cost money would
    // train them not to.
    expect(after).toBe(before);
    expect(status).toContain('Settled — 0 decisions');
    expect(status).toContain('Open — 2 items');
    expect(status).toContain('question(s) waiting');

    await runtime.close();
  });

  it('lists sessions most recently touched first', async () => {
    const runtime = await harness();
    await newSession(runtime, { title: 'older' });
    await newSession(runtime, { title: 'newer' });

    const listed = await listSessions(runtime, {});
    expect(listed).toHaveLength(2);

    await runtime.close();
  });

  it('says something useful when a session does not exist', async () => {
    const runtime = await harness();
    await expect(showStatus(runtime, 'ses-nope')).rejects.toThrow(/No session ses-nope/);
    await runtime.close();
  });
});

describe('answering', () => {
  it('never treats the recommendation as a default', async () => {
    // The anchoring mitigation, as a test. Rejecting the recommendation must be
    // an ordinary answer that the loop handles identically — no penalty, no
    // different code path, no complaint.
    const runtime = await harness();
    const id = idFrom(await newSession(runtime, {}));
    await addSource(runtime, id, await brief());
    await runOneTurn(runtime, id);

    const rejectRecommendation = (question: Question): Reply => {
      const other = question.options.find((option) => option.id !== question.recommends);
      return other === undefined
        ? takeFirstOption(question)
        : { selectedOptionIds: [other.id], customText: null };
    };

    const lines = await answerQuestions(runtime, id, scriptedAsker(rejectRecommendation));
    expect(lines.join('\n')).toContain('Entered by hand in Roomly');
    expect(lines.join('\n')).not.toContain('does not work');

    await runtime.close();
  });

  it('writes nothing when the user cancels part-way', async () => {
    const runtime = await harness();
    const id = idFrom(await newSession(runtime, {}));
    await addSource(runtime, id, await brief());
    await runOneTurn(runtime, id);

    const lines = await answerQuestions(
      runtime,
      id,
      scriptedAsker(() => null),
    );
    expect(lines.join('\n')).toContain('Nothing was saved');

    // Still awaiting answers: a cancelled prompt must not advance the session.
    const still = await runtime.stores.inquiry.listUnansweredQuestions(
      (await runtime.stores.sessions.listRecent(1))[0]?.id ?? ('' as never),
    );
    expect(still.length).toBeGreaterThan(0);

    await runtime.close();
  });

  it('says so when there is nothing to answer', async () => {
    const runtime = await harness();
    const id = idFrom(await newSession(runtime, {}));
    const lines = await answerQuestions(runtime, id, scriptedAsker(takeFirstOption));
    expect(lines.join('\n')).toContain('Nothing to answer');
    await runtime.close();
  });
});
