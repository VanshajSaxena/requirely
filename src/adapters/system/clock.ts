import type { Clock, Timestamp } from '../../domain/index.ts';

/**
 * The one place in the application allowed to read the wall clock.
 *
 * `src/domain/` and `src/engine/` are forbidden from calling `new Date()` by
 * `scripts/check-boundaries.sh`; this adapter is where that call legitimately
 * lives, and swapping it for a fixture clock is what makes the loop replayable.
 */
export function systemClock(): Clock {
  return {
    now: (): Timestamp => new Date().toISOString(),
  };
}
