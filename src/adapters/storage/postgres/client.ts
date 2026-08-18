import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
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
      const migrationClient = postgres(url, { max: 1 });
      try {
        await migrate(drizzle(migrationClient, { schema }), { migrationsFolder: './drizzle' });
      } finally {
        await migrationClient.end();
      }
    },
    async close() {
      await client.end();
    },
  };
}
