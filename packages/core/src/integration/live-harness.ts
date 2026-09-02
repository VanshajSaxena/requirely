import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The bits every model-backed test needs, shared so two of them cannot grow two
 * different ideas of when to skip.
 *
 * There are two such tests and they answer different questions. `live.test.ts`
 * asks *does the engine work against a real provider* — one session, once.
 * `strategy.eval.test.ts` asks *which configuration is better* — the same
 * session several ways, compared. Merging them would make one file that answers
 * neither question clearly; duplicating the cassette machinery would make two
 * files that disagree about what "no cassettes" means.
 */

export const LIVE = process.env.REQUIRELY_LIVE === '1';

/**
 * Deliberately its own variable, not `REQUIRELY_REASONING_MODEL`.
 *
 * The harness wants the cheapest model that can exercise the loop; the app wants
 * the best one it can afford. Sharing a variable would also create an ordering
 * trap: `.env` is loaded inside each test's setup, after this module runs, so
 * reading the app's setting here would silently honour it in some run orders and
 * not others.
 */
export const MODEL = process.env.REQUIRELY_LIVE_MODEL ?? 'claude-haiku-4-5';

export const CASSETTES = join(import.meta.dirname, '../../cassettes/live');
export const REPO_ENV = join(import.meta.dirname, '../../../../.env');

/**
 * Cassettes are matched on a hash, so the filename cannot say which model
 * recorded them — the body can. Reading it is what stops a replay of one
 * model's session from silently standing in for another's.
 */
export function hasCassettesFor(model: string): boolean {
  try {
    return readdirSync(CASSETTES).some(
      (file) =>
        file.endsWith('.json') &&
        (JSON.parse(readFileSync(join(CASSETTES, file), 'utf8')) as { model?: string }).model ===
          model,
    );
  } catch {
    return false;
  }
}

/**
 * **This guard answers "was anything ever recorded?", not "is it still valid?"**
 *
 * The cassette key is a hash of `(operation, instructions, input)`, so changing a
 * prompt or a schema does not invalidate a cassette — it *orphans* it, and the
 * next replay throws `no cassette at …` from inside the run rather than skipping
 * here. That happened for real when Phase 8 reshaped the domain: the Phase 7
 * recordings were still present and still named the right model, so this
 * returned true and the failure surfaced three calls deep.
 *
 * The fix when it happens is to delete the orphans, not to widen this check: a
 * cassette recorded against a schema that no longer exists is evidence for a
 * claim that is no longer being made. Deleting them makes the skip honest again.
 */
export const RUNNABLE = LIVE || hasCassettesFor(MODEL);

/**
 * Says out loud that nothing ran.
 *
 * A silent skip reads like a pass. The suite still goes green, which is correct
 * — nothing is broken — but the output has to say why, or "all tests passing"
 * quietly starts meaning "all tests that ran". `process.stderr` rather than
 * `console.warn`: vitest buffers console output per test and prints nothing for
 * a file where no test ran, which is exactly the case this exists for.
 */
export function announceSkip(what: string): void {
  process.stderr.write(
    `\n[${what}] SKIPPED — no cassettes for "${MODEL}" under ${CASSETTES}\n` +
      `[${what}] record with: REQUIRELY_LIVE=1 pnpm --filter @requirely/core exec vitest run src/integration/\n\n`,
  );
}
