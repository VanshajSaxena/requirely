import { z } from 'zod';

/**
 * Timestamps are ISO-8601 strings, not `Date`.
 *
 * Understanding revisions are stored as JSONB and compared in snapshot tests.
 * A string round-trips through `JSON.parse(JSON.stringify(x))` unchanged; a
 * `Date` silently becomes a string on the way out and never becomes a `Date`
 * again on the way back, which makes stored and in-memory shapes diverge.
 */
export const Timestamp = z.iso.datetime();
export type Timestamp = z.infer<typeof Timestamp>;
