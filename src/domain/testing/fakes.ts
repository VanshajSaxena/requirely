import type { Clock } from '../ports/clock.ts';
import type { IdGenerator } from '../ports/id-generator.ts';
import { type EntityKind, ID_PREFIX } from '../shared/ids.ts';
import type { Timestamp } from '../shared/time.ts';

/**
 * Deterministic implementations of the two ambient-state ports.
 *
 * These live in the domain because they are pure — no I/O, no ambient clock, no
 * randomness — and because the engine's tests in the next phase need exactly the
 * same doubles. Note that neither reads the real clock: `advancingClock` walks a
 * caller-supplied list rather than computing offsets from `Date`, which keeps
 * the determinism rule true even here.
 */

/** Produces `req_1`, `req_2`, … per entity kind. Readable in failure output. */
export function sequentialIdGenerator(): IdGenerator {
  const counters = new Map<EntityKind, number>();
  return {
    next(kind: EntityKind): string {
      const next = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, next);
      return `${ID_PREFIX[kind]}_${next}`;
    },
  };
}

export function fixedClock(at: Timestamp = '2026-01-01T00:00:00.000Z'): Clock {
  return { now: () => at };
}

/** Returns each timestamp in turn, then repeats the last one. */
export function advancingClock(timestamps: readonly Timestamp[]): Clock {
  if (timestamps.length === 0) throw new Error('advancingClock requires at least one timestamp');
  let index = 0;
  return {
    now(): Timestamp {
      const current = timestamps[Math.min(index, timestamps.length - 1)];
      index += 1;
      // Guarded by the length check above; keeps noUncheckedIndexedAccess happy.
      return current ?? timestamps[timestamps.length - 1] ?? '';
    },
  };
}
