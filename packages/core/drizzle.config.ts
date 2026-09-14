import { join } from 'node:path';
import { defineConfig } from 'drizzle-kit';

/**
 * Load the repo-root `.env` before reading `DATABASE_URL`.
 *
 * **Without this, `pnpm db:migrate` silently migrates the wrong database.**
 * drizzle-kit does not load `.env`, so `DATABASE_URL` is undefined and the
 * fallback below applies — and that fallback names port 5432, which on a machine
 * with a native Postgres is somebody else's server. drizzle-kit then swallows the
 * driver's error inside its spinner, so the whole visible symptom is
 * `applying migrations...` and a bare non-zero exit.
 *
 * **`process.cwd()`, not `import.meta.dirname`.** Measured: drizzle-kit
 * transpiles this config with esbuild to CJS, where `import.meta.dirname` is
 * `undefined` — so `join(import.meta.dirname, ...)` throws. Under a plain `node`
 * import the same file resolves correctly, which is what makes the bug invisible:
 * it works when you test it and fails when drizzle-kit runs it.
 *
 * cwd is trustworthy here specifically because the `db:*` scripts are declared in
 * this package, so pnpm runs them with cwd = `packages/core`. That is a narrower
 * claim than "cwd is fine", and it is the reason this is not the same mistake
 * `migrations.ts` exists to correct.
 */
const REPO_ENV = join(process.cwd(), '../../.env');
try {
  process.loadEnvFile(REPO_ENV);
} catch {
  // A missing `.env` is legitimate — CI passes DATABASE_URL directly.
}

const FALLBACK_URL = 'postgres://requirely:requirely@localhost:5432/requirely';
const url = process.env.DATABASE_URL;

if (url === undefined) {
  // Announced rather than silent. This is the exact path that migrated the wrong
  // server, and the only thing that made it survive was that nothing said so.
  // Not a throw: `db:generate` needs no database and must still work without one.
  process.stderr.write(
    `drizzle.config.ts: no DATABASE_URL (looked in ${REPO_ENV}); falling back to ${FALLBACK_URL}\n`,
  );
}

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
  dbCredentials: { url: url ?? FALLBACK_URL },
});
