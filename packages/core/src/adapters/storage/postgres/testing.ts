import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { MIGRATIONS_FOLDER } from './migrations.ts';
import type { Database } from './repositories.ts';
import { schema } from './schema.ts';

/**
 * A real Postgres, in-process.
 *
 * PGlite is Postgres compiled to WASM — not an emulation — so JSONB semantics,
 * unique constraints, foreign keys, and transaction rollback all behave as they
 * will in production. No Docker, and a fresh isolated database per call, which
 * is what makes it usable for hermetic tests.
 *
 * **Test-only.** `@electric-sql/pglite` is a devDependency; nothing under
 * `src/` outside tests may import this file. `docker-compose.yml` remains the
 * path for developing against a real server.
 */

export interface TestDatabase {
  readonly db: Database;
  close(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  // `memory://` gives each call its own database, so suites cannot leak into
  // one another through shared state.
  const client = new PGlite('memory://');
  const db = drizzle(client, { schema });

  // The same committed SQL production runs. Applying it here is what makes
  // schema.ts and the migrations provably agree — a drift between them fails
  // every query in the contract suite rather than surfacing in production.
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  return {
    db,
    async close() {
      await client.close();
    },
  };
}
