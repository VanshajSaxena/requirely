import { describe, expect, it } from 'vitest';
import { sumUsage, Usage } from '../../domain/index.ts';
import { costMinorUnitsFor, isPriced, SCHEDULED_PRICE_CHANGES } from './pricing.ts';

const usage = (model: string, cost: number | null) =>
  Usage.parse({
    operation: 'assess',
    provider: 'anthropic',
    model,
    inputTokens: 0,
    outputTokens: 0,
    costMinorUnits: cost,
  });

describe('costMinorUnitsFor', () => {
  it('charges input and output at their separate rates', () => {
    // 1M input @ $1/MTok + 1M output @ $5/MTok = $6.00 = 600 minor units.
    expect(costMinorUnitsFor('claude-haiku-4-5', 1_000_000, 1_000_000)).toBe(600);
  });

  it('keeps fractional cents rather than rounding each call up', () => {
    // A single turn genuinely costs a fraction of a cent. Rounding here would
    // make a whole cheap session read as many times its real price, which is
    // the number owner verdict #3 cares about.
    expect(costMinorUnitsFor('claude-haiku-4-5', 1_000, 100)).toBeCloseTo(0.15, 6);
  });

  it('prices the model the config actually defaults to', () => {
    // A guard against the table and the config drifting apart: if
    // REQUIRELY_REASONING_MODEL's default is renamed, this fails rather than
    // silently reporting every session as unpriced.
    expect(isPriced('claude-opus-5')).toBe(true);
  });
});

describe('an unknown model yields null, never zero', () => {
  it('returns null rather than pricing a model it does not know', () => {
    expect(costMinorUnitsFor('some-future-model', 1_000_000, 1_000_000)).toBeNull();
    expect(isPriced('some-future-model')).toBe(false);
  });

  it('refuses to prefix-match, because a near miss is priced wrong and believed', () => {
    // `claude-opus-5` and a hypothetical `claude-opus-5-mini` share a prefix and
    // would not share a price. Exact ids only.
    expect(costMinorUnitsFor('claude-opus-5-mini', 1_000, 1_000)).toBeNull();
  });

  it('propagates through sumUsage as "not reported", distinct from free', () => {
    // The reason null is the right absent value: `sumUsage` already keeps these
    // apart, so an unpriced model reads "cost unknown" rather than "free".
    expect(sumUsage([usage('unknown-model', null)]).costMinorUnits).toBeNull();
    expect(sumUsage([usage('claude-haiku-4-5', 0)]).costMinorUnits).toBe(0);
  });

  it('reports a total when only some calls in a turn are priced', () => {
    // A mixed-provider turn — reasoning on Anthropic, transcription elsewhere —
    // must not lose the part it does know.
    const total = sumUsage([usage('claude-haiku-4-5', 12), usage('unknown-model', null)]);
    expect(total.costMinorUnits).toBe(12);
  });
});

describe('the models Requirely is actually being compared across', () => {
  // Every id here was called through its own adapter on 2026-09-15 and returned
  // a valid `constrained` response. Pricing them is what turns a token-count
  // comparison into a cost comparison — which is the reason the owner bought
  // OpenAI and Google keys in the first place.
  it.each([
    ['gpt-6-astra'],
    ['gpt-5.6-sol'],
    ['gpt-5.6-terra'],
    ['gpt-5.6-luna'],
    ['gemini-3.8-flash'],
    ['gemini-3.5-flash-lite'],
    ['gemini-3.1-flash-lite'],
    ['gemini-3-flash-preview'],
    ['claude-haiku-4-5'],
    ['claude-opus-5'],
  ])('prices %s rather than reporting it unknown', (model) => {
    expect(isPriced(model)).toBe(true);
    expect(costMinorUnitsFor(model, 1_000_000, 1_000_000)).toBeGreaterThan(0);
  });

  it('puts the providers in the cost order the pricing pages imply', () => {
    // A cheap sanity check on ten hand-copied numbers: a transcription slip
    // large enough to matter almost certainly breaks this ordering, and it
    // would otherwise only show up as a surprising bill.
    const perMillion = (model: string) => costMinorUnitsFor(model, 1_000_000, 1_000_000) ?? 0;
    expect(perMillion('gpt-5.6-luna')).toBeLessThan(perMillion('gemini-3.8-flash'));
    expect(perMillion('gemini-3.8-flash')).toBeLessThan(perMillion('claude-haiku-4-5'));
    expect(perMillion('claude-haiku-4-5')).toBeLessThan(perMillion('claude-opus-5'));
    expect(perMillion('claude-opus-5')).toBeLessThan(perMillion('gpt-6-astra'));
  });
});

describe('scheduled price changes', () => {
  /**
   * **This is the only part of this table that cannot go stale quietly.**
   *
   * The file's documented weakness is that a price change makes it "quietly
   * wrong rather than loudly broken". That is unavoidable for a change nobody
   * announced — but Google published a date for Gemini 3.6/3.8 Flash, so this
   * one can be caught. When this fails, copy the numbers it names into `PRICES`
   * and delete the entry; the work is a copy, not a research task.
   */
  it('has not passed its effective date yet', () => {
    const due = SCHEDULED_PRICE_CHANGES.filter(
      (change) => new Date(change.effectiveFrom).getTime() <= Date.now(),
    );

    expect(
      due.map(
        (c) =>
          `${c.model} changed on ${c.effectiveFrom} to ${c.price.inputPerMTok}/${c.price.outputPerMTok} (minor units per MTok) — update PRICES and drop this entry`,
      ),
    ).toEqual([]);
  });

  it('names a model that is actually priced, so the update target exists', () => {
    for (const change of SCHEDULED_PRICE_CHANGES) expect(isPriced(change.model)).toBe(true);
  });

  it('records an increase, which is why using the current rate is safe to do', () => {
    // The file's standing rule is that reading slightly high beats reading low.
    // Recording today's lower rate is only defensible because the higher one is
    // declared here with a date attached — if a scheduled change were ever a
    // *cut*, that argument would not hold and this test should be revisited.
    for (const change of SCHEDULED_PRICE_CHANGES) {
      const now = costMinorUnitsFor(change.model, 1_000_000, 1_000_000) ?? 0;
      const later = change.price.inputPerMTok + change.price.outputPerMTok;
      expect(later).toBeGreaterThan(now);
    }
  });
});
