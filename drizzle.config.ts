import { defineConfig } from 'drizzle-kit';

/**
 * Migrations are generated from `schema.ts` and committed as SQL.
 *
 * The generated SQL is the artifact that actually runs — review it in diffs the
 * same way you would review hand-written DDL, because a schema change that reads
 * innocently in TypeScript can produce a destructive migration.
 */
export default defineConfig({
  schema: './src/adapters/storage/postgres/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://requirely:requirely@localhost:5432/requirely',
  },
});
