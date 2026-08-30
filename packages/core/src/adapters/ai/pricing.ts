/**
 * Per-model prices, so `Usage.costMinorUnits` stops being permanently null.
 *
 * The domain reserved that field in Phase 1 — *"capturing cost at the boundary
 * rather than at each call site is what makes per-session cost accounting
 * possible later without touching engine code"* — and then nothing filled it.
 * This is the filling. It matters more than a printed number: `Turn` stores
 * `usage`, so once this is populated "what did that session cost?" stays
 * answerable from the database forever, which is what owner verdict #3 (token
 * spend is a standing priority) actually needs.
 *
 * ## Three deliberate choices
 *
 * **Minor units are cents, and fractional.** `Usage.costMinorUnits` is
 * `z.number().nonnegative()`, not an integer, because a single turn genuinely
 * costs a fraction of a cent and rounding each call to a whole cent would make
 * a cheap session look ten times its real price.
 *
 * **Exact model ids only — no prefix matching.** `claude-opus-5` and a
 * hypothetical `claude-opus-5-mini` would share a prefix and not a price. A
 * near-match that silently prices wrong is worse than no price, because a wrong
 * number is believed and a missing one is questioned.
 *
 * **An unknown model returns `null`, never `0`.** `sumUsage` already keeps those
 * apart, so an unpriced model reads "cost unknown" rather than "free". That is
 * the same asymmetry `projection/citations.ts` uses for an unknown source: the
 * blast radius of an absent number is one blank field, and of a wrong one is a
 * decision made on a lie.
 *
 * ## The known weakness
 *
 * **This table goes stale, and nothing here can detect that.** It is a snapshot
 * of published list prices, not a live lookup, so a price change makes it
 * quietly wrong rather than loudly broken. Two mitigations, neither perfect: the
 * `null` path above means an *unknown* model is never mispriced, and the date
 * below says how old the numbers are. Anything reading these figures should call
 * them an estimate.
 *
 * Verified 2026-08-28 against Anthropic's published list pricing. Introductory
 * or promotional discounts are deliberately **not** modelled — they expire, and
 * an estimate that reads slightly high is safer than one that reads low.
 *
 * OpenAI models are absent rather than guessed. They take the `null` path, which
 * is exactly what that path is for.
 */

interface ModelPrice {
  /** Minor units (cents) per million input tokens. */
  readonly inputPerMTok: number;
  /** Minor units (cents) per million output tokens. */
  readonly outputPerMTok: number;
}

const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5': { inputPerMTok: 1_000, outputPerMTok: 5_000 },
  'claude-mythos-5': { inputPerMTok: 1_000, outputPerMTok: 5_000 },
  'claude-opus-5': { inputPerMTok: 500, outputPerMTok: 2_500 },
  'claude-opus-4-8': { inputPerMTok: 500, outputPerMTok: 2_500 },
  'claude-opus-4-7': { inputPerMTok: 500, outputPerMTok: 2_500 },
  'claude-opus-4-6': { inputPerMTok: 500, outputPerMTok: 2_500 },
  'claude-sonnet-5': { inputPerMTok: 300, outputPerMTok: 1_500 },
  'claude-sonnet-4-6': { inputPerMTok: 300, outputPerMTok: 1_500 },
  'claude-haiku-4-5': { inputPerMTok: 100, outputPerMTok: 500 },
};

const PER_MTOK = 1_000_000;

/** Cost in minor units, or `null` when this model has no published price here. */
export function costMinorUnitsFor(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = PRICES[modelId];
  if (price === undefined) return null;

  return (
    (inputTokens * price.inputPerMTok) / PER_MTOK + (outputTokens * price.outputPerMTok) / PER_MTOK
  );
}

/** Whether a price is known, so a caller can say "unpriced" rather than guess why. */
export const isPriced = (modelId: string): boolean => PRICES[modelId] !== undefined;
