import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { MIGRATIONS_FOLDER } from './migrations.ts';
import type { Database } from './repositories.ts';
import { schema } from './schema.ts';

/**
 * The production connection.
 *
 * PGlite is used in tests (see `testing.ts`), and both are driven through the
 * same `Database` type, so test coverage says something about this path rather
 * than about a parallel one.
 */

export interface PostgresConnection {
  readonly db: Database;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export function createPostgresConnection(url: string): PostgresConnection {
  // `max: 1` for migrations would be safer, but this connection is also the
  // application's pool; migrations run through their own short-lived client.
  const client = postgres(url);
  const db = drizzle(client, { schema });

  return {
    db,
    async migrate() {
      // `onnotice` is silenced for this client only, and only because the
      // migrator's own bootstrap is built from `CREATE SCHEMA IF NOT EXISTS` and
      // `CREATE TABLE IF NOT EXISTS` — which raise a NOTICE every time they do
      // exactly what they were asked to do. postgres-js routes notices to
      // `console.log` by default, so an already-migrated database printed 18
      // lines of "already exists, skipping" before *every* CLI command's real
      // output. Nothing is being hidden: these carry no information that the
      // statement's own success does not.
      const migrationClient = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await migrate(drizzle(migrationClient, { schema }), {
          migrationsFolder: MIGRATIONS_FOLDER,
        });
      } finally {
        await migrationClient.end();
      }
    },
    async close() {
      await client.end();
    },
  };
}
