import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CallEvent, CallObserver } from '@requirely/core/server';

/**
 * Every call, on disk, always.
 *
 * **Why always rather than behind a flag.** The interesting failure is the one
 * you did not expect, and reproducing it costs a live turn — real money and two
 * minutes. Capturing unconditionally means the last failure is already
 * inspectable. The cost is a few hundred KB per turn and a prune.
 *
 * **What is in it is your own material.** The full system prompt, the full
 * input — which is your sources, your understanding and your answers — and the
 * model's output. No credential ever reaches here (the key lives on the adapter
 * config and never enters a `CallEvent`), but a run directory is not a safe
 * thing to paste into a bug report unread. Said again in `docs/RUNNING.md`,
 * where someone about to do it will be looking.
 *
 * **JSONL, not JSON.** A crashed process leaves a truncated last line and every
 * line before it still parses. A single JSON array would leave an unclosed
 * bracket and lose the whole file — which is precisely the run you wanted.
 *
 * **The directory appears on the first event, not at construction.** Every
 * command builds a runtime, but only a turn against a real provider produces
 * anything to record: a `--script` run makes no provider call, and neither does
 * the test suite. Creating eagerly left an empty directory behind for each —
 * measured at 11 from one `pnpm verify` — and pruning to a cap meant those
 * empties evicted the real runs worth keeping.
 */

/** Kept small on purpose: this is a debugging aid, not an archive. */
const DEFAULT_KEEP = 20;

export interface RunLogOptions {
  readonly dir: string;
  readonly sessionId?: string | undefined;
  readonly keep?: number | undefined;
  /** Redacts anything secret-shaped out of free text before it is written. */
  readonly redact?: ((text: string) => string) | undefined;
}

export interface RunLog extends CallObserver {
  /** Where this run is being written, for the CLI to print once at the end. */
  readonly path: string;
  /** Whether anything was actually recorded — false for a run that made no call. */
  readonly recorded: boolean;
  /** Records the turn's outcome alongside the calls. */
  finish(summary: Record<string, unknown>): void;
}

export function createRunLog(options: RunLogOptions): RunLog {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(
    options.dir,
    `${stamp}${options.sessionId === undefined ? '' : `-${options.sessionId}`}`,
  );
  const redact = options.redact ?? ((text: string): string => text);
  const calls = join(path, 'calls.jsonl');
  // Two flags, not one. `attempted` stops a failing mkdir being retried on
  // every event; `usable` is what `recorded` reports, so a run whose directory
  // could not be created says it wrote nothing — which is true. Collapsing
  // them would make the CLI print a `payloads:` path that does not exist.
  let attempted = false;
  let usable = false;

  const ensure = (): boolean => {
    if (attempted) return usable;
    attempted = true;
    try {
      mkdirSync(path, { recursive: true });
      usable = true;
      // Pruned here rather than at construction, so the count reflects runs
      // that actually recorded something.
      prune(options.dir, options.keep ?? DEFAULT_KEEP);
    } catch {
      // Deliberate. See `append` below: losing the log must never lose the turn.
      usable = false;
    }
    return usable;
  };
  // Monotonic and injected, rather than read from the event: `CallEvent`
  // deliberately carries no timestamp, because a sink always knows the time and
  // a core that minted one would need the `Clock` port threaded through a
  // diagnostic. Elapsed is derived here by pairing start with end.
  const startedAt = new Map<string, number>();

  return {
    path,
    get recorded(): boolean {
      return usable;
    },

    observe(event: CallEvent): void {
      if (!ensure()) return;
      const at = Date.now();
      const elapsedMs =
        event.kind === 'call.start' ? null : elapsedFor(startedAt, event.callId, at);
      if (event.kind === 'call.start') startedAt.set(event.callId, at);

      append(
        calls,
        redact(JSON.stringify({ at: new Date(at).toISOString(), elapsedMs, ...event })),
      );
    },

    finish(summary: Record<string, unknown>): void {
      // Deliberately does *not* `ensure()`. A turn with no provider call has
      // nothing to explain, and a directory holding only a verdict is noise.
      if (!usable) return;
      write(join(path, 'turn.json'), redact(`${JSON.stringify(summary, null, 2)}\n`));
    },
  };
}

const elapsedFor = (started: Map<string, number>, callId: string, at: number): number | null => {
  const began = started.get(callId);
  if (began === undefined) return null;
  started.delete(callId);
  return at - began;
};

/**
 * Writing the log must never be the reason a command fails.
 *
 * A read-only filesystem, a full disk or a directory someone chmod'd are all
 * real, and none of them is a reason to lose a turn that has already been paid
 * for. Swallowing an error is normally the wrong instinct; here the alternative
 * is discarding the work the log exists to describe.
 */
function append(file: string, line: string): void {
  try {
    appendFileSync(file, `${line}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

function write(file: string, body: string): void {
  try {
    writeFileSync(file, body, 'utf8');
  } catch {
    /* ignore */
  }
}

/** Keep the most recent `keep` run directories; drop the rest. */
function prune(dir: string, keep: number): void {
  try {
    const runs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      // Names begin with an ISO-8601 UTC timestamp with `:` and `.` replaced by
      // `-`, which is still lexicographically ordered — same fixed-width,
      // most-significant-first property that makes ISO sortable at all.
      .map((entry) => entry.name)
      .sort();

    for (const stale of runs.slice(0, Math.max(0, runs.length - keep))) {
      rmSync(join(dir, stale), { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
}
