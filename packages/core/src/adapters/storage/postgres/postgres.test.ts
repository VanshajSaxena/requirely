import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ConflictError, QuestionId } from '../../../domain/index.ts';
import { describeStorageContract, fixtures } from '../storage-contract.ts';
import { postgresStores } from './repositories.ts';
import { createTestDatabase } from './testing.ts';

/**
 * The same contract as the in-memory adapter, run against real Postgres.
 *
 * PGlite is Postgres compiled to WASM, so transaction rollback, unique
 * constraints and JSONB behave exactly as they will in production — which is
 * what makes the atomicity assertions in the shared suite meaningful here.
 */
describeStorageContract('postgres (pglite)', async () => {
  const database = await createTestDatabase();
  return {
    stores: postgresStores(database.db),
    close: () => database.close(),
  };
});

/**
 * The regression test for a shipped bug: `QuestionOption.commits` was renamed to
 * `means`, and eight stored rows kept the old key inside `questions.options`.
 *
 * **Nothing could have caught it.** `options` is `jsonb(...).$type<QuestionOption[]>()`
 * and `$type<>` is a TypeScript assertion with no DDL presence, so drizzle-kit
 * diffed the two new *columns* in that phase and was structurally blind to a
 * rename inside this one. The test suite builds an empty database per run and
 * writes in the current shape, so it cannot observe a row written by an older
 * version of the code.
 *
 * This writes one deliberately, which is the only way to have that row exist.
 */
describe('a row written by an older version of the code', () => {
  it('names the table and the id instead of dumping Zod issues', async () => {
    const database = await createTestDatabase();
    const stores = postgresStores(database.db);

    await stores.sessions.create(fixtures.session());
    await stores.sources.add(fixtures.source());
    await stores.committer.commit(fixtures.commit());

    // The pre-rename shape, straight past the domain — which is exactly how it
    // got there the first time: written by code that was correct at the time.
    await database.db.execute(
      sql`update questions set options = ${JSON.stringify([
        { id: 'opt-1', label: 'Anyone', commits: 'Open sign-up.', settles: [] },
      ])}::jsonb where id = 'qst-1'`,
    );

    const failure = await stores.inquiry
      .findQuestion(QuestionId.parse('qst-1'))
      .then(() => null)
      .catch((error: unknown) => (error as Error).message);

    expect(failure).toContain('Stored question row qst-1');
    expect(failure).toContain('options.0.means');
    // The sentence that would have turned this from a puzzle into a one-liner.
    expect(failure).toContain('data migration');

    await database.close();
  });
});

/**
 * The cause-walk in `uniqueViolation`, pinned.
 *
 * Lives here rather than in the shared contract because it is a *driver* fact,
 * not a port guarantee: the in-memory adapter has no constraint names to report.
 * The contract asserts the error type across both adapters; this asserts that
 * the translation actually reached the driver's own answer.
 *
 * **Why it needs a test at all.** Drizzle wraps every driver error, so `.code`
 * sits on `error.cause` rather than on the error — a plain
 * `error.code === '23505'` matches nothing, fails silently, and the mapping
 * simply never fires until a real duplicate reaches production. Nothing else in
 * the suite would notice, because "it threw" stays true either way.
 */
describe('translating a unique violation', () => {
  it('reaches through the drizzle wrapper for the constraint name', async () => {
    const database = await createTestDatabase();
    const stores = postgresStores(database.db);
    const session = fixtures.session();
    await stores.sessions.create(session);

    const error = await stores.sessions
      .create(session)
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).constraint).toBe('sessions_pkey');
    // The driver's error is kept as the cause: translating must not throw away
    // what a person debugging a real incident would want.
    expect((error as ConflictError).cause).toBeDefined();

    await database.close();
  });
});
