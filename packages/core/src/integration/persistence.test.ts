import { afterEach, describe, expect, it } from 'vitest';
import type { FakeScript } from '../adapters/ai/fake.ts';
import { fakeStructuredGenerator } from '../adapters/ai/fake.ts';
import { postgresStores } from '../adapters/storage/postgres/repositories.ts';
import { createTestDatabase, type TestDatabase } from '../adapters/storage/postgres/testing.ts';
import {
  createSession,
  DEFAULT_SUFFICIENCY_POLICY,
  type Session,
  type TurnCommit,
} from '../domain/index.ts';
import { fixedClock, sequentialIdGenerator } from '../domain/testing/fakes.ts';
import { type EngineDeps, runTurn } from '../engine/loop.ts';
import { STRATEGIES } from '../engine/strategies.ts';
import { ingestText } from '../ingestion/text.ts';
import { answerAll, SOURCE_TEXT, TURN_1_SCRIPT, TURN_2_SCRIPT } from './scenario.ts';

/**
 * The loop against real Postgres, across a simulated process boundary.
 *
 * The point of the second half is that **every in-memory object is thrown away**
 * between the two turns — new repositories, new engine deps, session reloaded by
 * id. If turn 2 still reaches sufficiency, the session genuinely lives in
 * storage rather than in a variable that happened to survive.
 */

let database: TestDatabase | undefined;

afterEach(async () => {
  await database?.close();
  database = undefined;
});

/**
 * A fresh engine over an existing database — the stand-in for "a new process".
 * The clock and id generator are re-created too, so nothing carries over.
 */
function engineOver(db: TestDatabase, script: FakeScript, idStart = 1) {
  const stores = postgresStores(db.db);
  const generator = fakeStructuredGenerator(script);

  const deps: EngineDeps = {
    generator,
    sessions: stores.sessions,
    sources: stores.sources,
    revisions: stores.understanding,
    inquiry: stores.inquiry,
    clock: fixedClock('2026-01-01T00:00:00.000Z'),
    ids: sequentialIdGenerator(idStart),
    policy: DEFAULT_SUFFICIENCY_POLICY,
    strategy: STRATEGIES.separate,
    maxQuestionsPerTurn: 4,
  };

  return { deps, stores, generator };
}

async function runAndCommit(
  session: Session,
  request: Parameters<typeof runTurn>[1],
  engine: ReturnType<typeof engineOver>,
): Promise<TurnCommit> {
  const commit = await runTurn(session, request, engine.deps);
  await engine.stores.committer.commit(commit);
  return commit;
}

describe('the loop over Postgres', () => {
  it('resumes a session after every in-memory object is discarded', async () => {
    database = await createTestDatabase();

    // ---- process 1: ingest and run the first turn ----
    const first = engineOver(database, TURN_1_SCRIPT);

    const session = createSession({ questionBudget: 12, title: 'Requirely' }, first.deps);
    await first.stores.sessions.create(session);

    const source = ingestText(
      { sessionId: session.id, label: 'kickoff notes', text: SOURCE_TEXT, ordinal: 1 },
      first.deps,
    );
    await first.stores.sources.add(source);

    const turn1 = await runAndCommit(
      session,
      { trigger: 'initial', sourceIds: [source.id] },
      first,
    );
    expect(turn1.session.status).toBe('awaiting-answers');
    expect(turn1.questions).toHaveLength(2);

    // ---- process 2: nothing from above survives except the session id ----
    // A real IdGenerator never repeats across restarts, so the second "process"
    // starts from a range that cannot collide with the first.
    const second = engineOver(database, TURN_2_SCRIPT, 100);

    const reloaded = await second.stores.sessions.findById(session.id);
    expect(reloaded).not.toBeNull();
    if (reloaded === null) throw new Error('session did not survive storage');

    // The understanding is read back from Postgres, not carried in a variable.
    const stored = await second.stores.understanding.findLatest(session.id);
    expect(stored?.content.gaps).toHaveLength(2);
    expect(stored?.content.requirements[0]?.statement).toBe(
      'Ingest audio, text and documents into one understanding',
    );

    const questions = await second.stores.inquiry.listUnansweredQuestions(session.id);
    expect(questions).toHaveLength(2);

    const turn2 = await runAndCommit(
      reloaded,
      { trigger: 'answers-received', answers: answerAll(questions) },
      second,
    );

    expect(turn2.session.status).toBe('sufficient');
    expect(turn2.revision.revision).toBe(1);
    expect(turn2.revision.content.resolvedGaps).toHaveLength(2);
    expect(turn2.revision.content.gaps).toHaveLength(0);
    // Turn 1's requirement survived a full round-trip through JSONB.
    expect(turn2.revision.content.requirements).toHaveLength(2);
    expect(turn2.revision.content.requirements[0]?.id).toBe('req-1');
  });

  it('writes nothing when the turn fails, leaving the session resumable', async () => {
    database = await createTestDatabase();

    // A script with no `assess` response: the turn dies after `analyze`.
    const engine = engineOver(database, { analyze: TURN_1_SCRIPT.analyze ?? [] });

    const session = createSession({ questionBudget: 12 }, engine.deps);
    await engine.stores.sessions.create(session);
    const source = ingestText(
      { sessionId: session.id, label: 'notes', text: SOURCE_TEXT, ordinal: 1 },
      engine.deps,
    );
    await engine.stores.sources.add(source);

    await expect(
      runTurn(session, { trigger: 'initial', sourceIds: [source.id] }, engine.deps),
    ).rejects.toThrow();

    // The old loop wrote answers and a revision before the failing call. Now a
    // failed turn leaves storage exactly as it was.
    expect(await engine.stores.understanding.findLatest(session.id)).toBeNull();
    expect(await engine.stores.sessions.listTurns(session.id)).toEqual([]);
    expect(await engine.stores.inquiry.listUnansweredQuestions(session.id)).toEqual([]);
    expect((await engine.stores.sessions.findById(session.id))?.status).toBe('gathering');
  });

  it('round-trips timestamps through the database byte-identically', async () => {
    database = await createTestDatabase();
    const engine = engineOver(database, TURN_1_SCRIPT);

    const session = createSession({ questionBudget: 12 }, engine.deps);
    await engine.stores.sessions.create(session);

    const reloaded = await engine.stores.sessions.findById(session.id);
    // `text` columns rather than `timestamptz` is what makes this exact.
    expect(reloaded?.createdAt).toBe(session.createdAt);
    expect(reloaded?.updatedAt).toBe(session.updatedAt);
  });
});
