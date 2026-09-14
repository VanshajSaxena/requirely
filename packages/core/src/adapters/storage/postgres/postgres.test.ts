import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { QuestionId } from '../../../domain/index.ts';
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
