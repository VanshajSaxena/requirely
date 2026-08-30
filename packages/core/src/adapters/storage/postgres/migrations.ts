import { join } from 'node:path';

/**
 * Where the generated SQL lives, resolved against **this file** rather than cwd.
 *
 * It was `'./drizzle'`, which is cwd-relative, and `packages/core/CLAUDE.md`
 * named the failure before it happened: *"the first server-side consumer not
 * launched from this directory will hit this for real."* Phase 7's CLI is that
 * consumer — running it from `apps/cli` would have looked for
 * `apps/cli/drizzle`, found nothing, and either migrated zero tables or failed
 * with a path the user has no reason to recognise.
 *
 * Both the production client and the PGlite test harness read this one constant
 * so the two cannot drift. They sit at the same depth today; a shared constant
 * means that stops being load-bearing.
 *
 * `import.meta.dirname` needs ESM, which this package already is — and it is why
 * the path survives being imported from anywhere, including a bundled app.
 */
export const MIGRATIONS_FOLDER = join(import.meta.dirname, '../../../../drizzle');
