import type { Timestamp } from '../shared/time.ts';

/**
 * Time enters the domain only through here.
 *
 * A single `Date.now()` inside the engine makes every snapshot test of the loop
 * non-deterministic, and non-determinism arrives one convenient call at a time.
 * `scripts/check-boundaries.sh` enforces this.
 */
export interface Clock {
  now(): Timestamp;
}
