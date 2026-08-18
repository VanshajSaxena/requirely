import { describeStorageContract } from '../storage-contract.ts';
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
