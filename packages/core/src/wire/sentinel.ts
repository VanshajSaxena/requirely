import { z } from 'zod';

/**
 * The encoding that makes a wire schema cheap enough to compile.
 *
 * Providers turn a strict JSON Schema into a decoding grammar and cap its
 * branchiness. Anthropic's documented caps are **24 optional properties and 16
 * union-typed properties, per request, summed across every strict schema in it.**
 * The reflex fix — mark everything `required` and make it nullable — trades an
 * optional for a union and lands in the *tighter* budget.
 *
 * The way out is to remove the branch entirely. A field that can be absent is
 * encoded as one that is always present and sometimes **empty**:
 *
 * | Domain | Wire | Cost |
 * | --- | --- | --- |
 * | `quote?: string` | *optional* property | 1 optional |
 * | `quote: string \| null` | `["string","null"]` | 1 union |
 * | `quote: string`, `""` means absent | plain `string` | **nothing** |
 *
 * For an enum the same trick is `''` as a **member of the enum** rather than a
 * union with a literal — `z.enum(['', 'low', 'high'])` emits one `enum` keyword,
 * where `z.enum(['low','high']).nullable()` emits an `anyOf`. That distinction
 * is the whole reason this file exists as a vocabulary rather than as advice.
 *
 * **The sentinel is only unambiguous because every field it touches rejects the
 * empty string in the domain.** `quote`, `note`, `rationale`, `basis` and every
 * id are `.min(1)`, so `""` cannot be a real value and cannot be confused with
 * one. Re-check that before adding a field here; a field where empty is
 * meaningful must not use this encoding.
 */

/** The empty string, named, so its meaning is greppable rather than inferred. */
export const ABSENT = '';

/** An enum plus the absent sentinel, still one `enum` keyword and zero unions. */
export const optionalEnum = <const T extends readonly string[]>(values: T) =>
  z.enum([ABSENT, ...values] as unknown as [string, ...string[]]);

/** `''` on the wire becomes `null` in the domain. */
export const orNull = (value: string): string | null => (value === ABSENT ? null : value);

/** `null` in the domain becomes `''` on the wire. Total, so `encode` cannot drift. */
export const orAbsent = (value: string | null | undefined): string => value ?? ABSENT;

/**
 * A boolean cannot carry a sentinel, so a *revisable* boolean is a three-state
 * enum: `''` leaves the field alone, `yes`/`no` set it.
 *
 * `blocking: false` meaning "unchanged" would silently clear a veto flag on
 * every revision that did not restate it — the exact class of bug `patchOf`
 * exists to prevent, reintroduced through the wire.
 */
export const WireFlag = z.enum([ABSENT, 'yes', 'no']);
export type WireFlag = z.infer<typeof WireFlag>;

export const flagToBoolean = (flag: WireFlag): boolean | undefined =>
  flag === ABSENT ? undefined : flag === 'yes';

export const booleanToFlag = (value: boolean | undefined): WireFlag =>
  value === undefined ? ABSENT : value ? 'yes' : 'no';
