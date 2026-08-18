import { describe, expect, it } from 'vitest';
import { RequirementId, SessionId } from './ids.ts';
import { Provenance } from './provenance.ts';
import { Timestamp } from './time.ts';
// `Usage` is both a schema (value) and a type, so this must not be a type-only import.
import { sumUsage, Usage } from './usage.ts';

const usage = (inputTokens: number, outputTokens: number, cost: number | null): Usage =>
  Usage.parse({
    provider: 'fake',
    model: 'fake-1',
    inputTokens,
    outputTokens,
    costMinorUnits: cost,
  });

describe('branded ids', () => {
  it('rejects empty strings', () => {
    expect(() => SessionId.parse('')).toThrow();
  });

  it('produces values that are structurally strings', () => {
    expect(`${SessionId.parse('ses_1')}`).toBe('ses_1');
  });

  it('keeps distinct id types from being interchanged', () => {
    const requirementId = RequirementId.parse('req_1');
    // @ts-expect-error a RequirementId is not assignable to a SessionId
    const wrong: SessionId = requirementId;
    expect(wrong).toBe('req_1');
  });
});

describe('Timestamp', () => {
  it('accepts ISO-8601 and rejects loose date strings', () => {
    expect(Timestamp.parse('2026-08-13T00:00:00.000Z')).toBe('2026-08-13T00:00:00.000Z');
    expect(() => Timestamp.parse('13 Aug 2026')).toThrow();
  });
});

describe('Provenance', () => {
  it('defaults absent fields to null so the shape survives JSON round-tripping', () => {
    const provenance = Provenance.parse({ sourceId: 'src_1' });
    expect(provenance).toEqual({ sourceId: 'src_1', quote: null, note: null });
    expect(JSON.parse(JSON.stringify(provenance))).toEqual(provenance);
  });
});

describe('sumUsage', () => {
  it('totals tokens across entries', () => {
    const totals = sumUsage([usage(10, 5, 100), usage(20, 7, 200)]);
    expect(totals).toEqual({ inputTokens: 30, outputTokens: 12, costMinorUnits: 300 });
  });

  it('reports null cost when nothing reported a cost, distinguishing it from zero', () => {
    expect(sumUsage([usage(10, 5, null)]).costMinorUnits).toBeNull();
    expect(sumUsage([usage(10, 5, 0)]).costMinorUnits).toBe(0);
  });

  it('sums only the entries that reported a cost', () => {
    expect(sumUsage([usage(1, 1, 50), usage(1, 1, null)]).costMinorUnits).toBe(50);
  });

  it('returns zeroes for an empty list', () => {
    expect(sumUsage([])).toEqual({ inputTokens: 0, outputTokens: 0, costMinorUnits: null });
  });
});
