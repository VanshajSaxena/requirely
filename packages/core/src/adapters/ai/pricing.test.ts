import { describe, expect, it } from 'vitest';
import { sumUsage, Usage } from '../../domain/index.ts';
import { costMinorUnitsFor, isPriced } from './pricing.ts';

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
