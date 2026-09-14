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
 * Verified 2026-08-28 (Anthropic) and 2026-09-15 (OpenAI, Google) against each
 * vendor's published list pricing — read off the page, never recalled.
 *
 * **Open-ended promotional discounts are still not modelled**, for the reason
 * the rest of this file gives: they expire on a date nobody wrote down, and an
 * estimate reading slightly high is safer than one reading low.
 *
 * **A *scheduled* price change is a different thing, and is modelled.** Google
 * publishes Gemini 3.6/3.8 Flash at $0.75/$3.75 through 2026-12-31 and
 * $1.50/$7.50 from 2027-01-01 — a dated two-phase price, not a sweetener with an
 * unknown end. Using the future rate would make every reading today 2x too high,
 * which defeats the comparison these prices exist for; using the current rate
 * alone would go quietly wrong in the new year, which is this file's stated
 * weakness. So the current rate is recorded and the change is declared in
 * `SCHEDULED_PRICE_CHANGES`, where `pricing.test.ts` fails once the date passes
 * and hands over the replacement numbers. That turns "goes stale silently" into
 * "fails loudly on a known date" for these rows — which is more than the
 * Anthropic rows have.
 *
 * DeepSeek is absent rather than guessed, and that remains the correct state
 * rather than an omission: a near-match that prices wrong is worse than no
 * price, because a wrong number is believed and a missing one is questioned.
 * `isPriced` is how a caller says "unpriced" rather than guessing why.
 *
 * **Two limits the flat shape cannot express**, both recorded rather than
 * rounded away. `gemini-3.1-pro-preview` is tiered by prompt size — $2/$12 at or
 * below 200k tokens, $4/$18 above — and is priced here at the lower tier, which
 * is the only one a Requirely session realistically reaches (measured turns are
 * ~5k input). `gemini-3.1-flash-lite` and `gemini-3-flash-preview` charge more
 * for audio input than for text; the text rate is recorded because the reasoning
 * port only ever sends text. Audio goes through the `Transcriber` port, which
 * this table does not price at all.
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

  // OpenAI — verified 2026-09-15. All four were also called through
  // `openaiStructuredGenerator` on that date and returned `constrained` output.
  'gpt-6-astra': { inputPerMTok: 1_000, outputPerMTok: 5_000 },
  'gpt-5.6-sol': { inputPerMTok: 400, outputPerMTok: 2_000 },
  'gpt-5.6-terra': { inputPerMTok: 200, outputPerMTok: 1_200 },
  'gpt-5.6-luna': { inputPerMTok: 20, outputPerMTok: 120 },

  // Google — verified 2026-09-15. The two Flash entries carry a scheduled
  // increase; see SCHEDULED_PRICE_CHANGES below.
  'gemini-3.8-flash': { inputPerMTok: 75, outputPerMTok: 375 },
  'gemini-3.6-flash': { inputPerMTok: 75, outputPerMTok: 375 },
  'gemini-3.5-flash-lite': { inputPerMTok: 30, outputPerMTok: 250 },
  'gemini-3.1-flash-lite': { inputPerMTok: 25, outputPerMTok: 150 },
  'gemini-3-flash-preview': { inputPerMTok: 50, outputPerMTok: 300 },
  // Lower of two prompt-size tiers — see the note in the header.
  'gemini-3.1-pro-preview': { inputPerMTok: 200, outputPerMTok: 1_200 },
};

/**
 * Price changes the vendor has already published a date for.
 *
 * `pricing.test.ts` fails once `effectiveFrom` has passed, which is the whole
 * point: this file's documented weakness is that it "goes stale quietly", and a
 * change nobody has to remember is the one case where that can be fixed. The
 * replacement numbers sit right here so the fix is a copy, not a research task.
 */
export const SCHEDULED_PRICE_CHANGES: readonly {
  readonly model: string;
  readonly effectiveFrom: string;
  readonly price: ModelPrice;
}[] = [
  {
    model: 'gemini-3.8-flash',
    effectiveFrom: '2027-01-01',
    price: { inputPerMTok: 150, outputPerMTok: 750 },
  },
  {
    model: 'gemini-3.6-flash',
    effectiveFrom: '2027-01-01',
    price: { inputPerMTok: 150, outputPerMTok: 750 },
  },
];

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
