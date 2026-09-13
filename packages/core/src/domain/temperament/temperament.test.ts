import { describe, expect, it } from 'vitest';
import { DEFAULT_SUFFICIENCY_POLICY } from '../sufficiency/policy.ts';
import { temperamentBriefing } from './briefing.ts';
import { countsFor, policyFor } from './derive.ts';
import {
  BALANCED_TEMPERAMENT,
  bandOf,
  DIAL_NAMES,
  type DialName,
  TEMPERAMENT_PRESETS,
  Temperament,
} from './temperament.ts';

const CEILINGS = { maxQuestionsPerTurn: 4 };
const ALL = DIAL_NAMES;
const brief = (t: Temperament, dials: readonly DialName[] = ALL): string =>
  temperamentBriefing(t, dials, countsFor(t, CEILINGS));

const at = (overrides: Partial<Temperament>): Temperament =>
  Temperament.parse({ ...BALANCED_TEMPERAMENT, ...overrides });

describe('the dials themselves', () => {
  it('defaults to neutral on every one', () => {
    expect(Temperament.parse({})).toEqual(BALANCED_TEMPERAMENT);
    for (const dial of DIAL_NAMES) expect(BALANCED_TEMPERAMENT[dial]).toBe(0.5);
  });

  it('rejects a value outside 0..1 rather than clamping it', () => {
    // A clamp would silently accept a caller's misunderstanding of the scale.
    expect(() => Temperament.parse({ creativity: 1.5 })).toThrow();
    expect(() => Temperament.parse({ creativity: -0.1 })).toThrow();
  });

  it('derives its name list from the schema, so the two cannot drift', () => {
    expect([...DIAL_NAMES].sort()).toEqual(Object.keys(Temperament.shape).sort());
    expect(DIAL_NAMES).toHaveLength(5);
  });

  it('bands on thirds, inclusive at the lower edge', () => {
    expect(bandOf(0)).toBe('low');
    expect(bandOf(0.33)).toBe('low');
    expect(bandOf(0.34)).toBe('mid');
    expect(bandOf(0.66)).toBe('mid');
    expect(bandOf(0.67)).toBe('high');
    expect(bandOf(1)).toBe('high');
  });
});

describe('presets', () => {
  it('are all valid temperaments', () => {
    for (const preset of Object.values(TEMPERAMENT_PRESETS)) {
      expect(() => Temperament.parse(preset)).not.toThrow();
    }
  });

  it('separates the two personas on technicality and almost nothing else', () => {
    // The argument for a vector rather than an enum of modes, as a test: both
    // personas want heavy inference, and differ on the words they get back.
    const { explorer, translator } = TEMPERAMENT_PRESETS;
    expect(Math.abs(explorer.creativity - translator.creativity)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(explorer.assertiveness - translator.assertiveness)).toBeLessThanOrEqual(0.2);
    expect(explorer.technicality - translator.technicality).toBeGreaterThanOrEqual(0.4);
  });

  it('keeps `scribe` close to the behaviour the product had before dials existed', () => {
    // The old prompts said "be conservative" and "an assumption is a LAST
    // RESORT". That position did not disappear — it became one preset.
    expect(TEMPERAMENT_PRESETS.scribe.creativity).toBeLessThan(0.34);
    expect(TEMPERAMENT_PRESETS.scribe.assertiveness).toBeLessThan(0.34);
  });
});

describe('counts', () => {
  it('scales continuously with the dial', () => {
    expect(countsFor(at({ creativity: 0 }), CEILINGS).readingsPerInput).toBe(1);
    expect(countsFor(at({ creativity: 0.5 }), CEILINGS).readingsPerInput).toBe(3);
    expect(countsFor(at({ creativity: 1 }), CEILINGS).readingsPerInput).toBe(4);

    expect(countsFor(at({ curiosity: 0 }), CEILINGS).optionsPerQuestion).toBe(2);
    expect(countsFor(at({ curiosity: 1 }), CEILINGS).optionsPerQuestion).toBe(5);
  });

  it('never lets a dial raise a spend ceiling', () => {
    // The rule `MAX_OUTPUT_TOKENS` already follows: a knob that can increase
    // spend without an explicit config change is how a budget stops being one.
    const greedy = at({ curiosity: 1 });
    expect(countsFor(greedy, { maxQuestionsPerTurn: 4 }).questionsPerTurn).toBe(4);
    expect(countsFor(greedy, { maxQuestionsPerTurn: 99 }).questionsPerTurn).toBe(6);
    expect(countsFor(greedy, { maxQuestionsPerTurn: 1 }).questionsPerTurn).toBe(1);
  });
});

describe('policy derivation', () => {
  it('reproduces today’s values at the neutral setting', () => {
    // Neutral thoroughness must not quietly move the bar the product already had.
    const derived = policyFor(BALANCED_TEMPERAMENT);
    expect(derived.minimumSettledRatio).toBe(DEFAULT_SUFFICIENCY_POLICY.minimumSettledRatio);
    expect(derived.stallAfterTurnsWithoutProgress).toBe(
      DEFAULT_SUFFICIENCY_POLICY.stallAfterTurnsWithoutProgress,
    );
  });

  it('moves the bar with thoroughness', () => {
    expect(policyFor(at({ thoroughness: 0 })).minimumSettledRatio).toBe(0.3);
    expect(policyFor(at({ thoroughness: 1 })).minimumSettledRatio).toBe(0.7);
    expect(policyFor(at({ thoroughness: 0 })).stallAfterTurnsWithoutProgress).toBe(1);
    expect(policyFor(at({ thoroughness: 1 })).stallAfterTurnsWithoutProgress).toBe(3);
  });

  it('leaves what is not a matter of taste alone', () => {
    // A slider must not be able to redefine what "understood" means, or
    // `sufficient` says something different in every session.
    const derived = policyFor(at({ thoroughness: 0 }));
    expect(derived.requiredDimensions).toEqual(DEFAULT_SUFFICIENCY_POLICY.requiredDimensions);
    expect(derived.weakCoverageBelow).toBe(DEFAULT_SUFFICIENCY_POLICY.weakCoverageBelow);
  });
});

describe('the briefing is not a placebo', () => {
  /**
   * **The load-bearing test of this whole phase.**
   *
   * `engine/prompts.ts` carried "You are not a question-asking machine" twice —
   * the same paragraph top and bottom — and the questions stayed interrogatory.
   * A knob that changes no instruction is exactly that failure with a number
   * attached, and it would ship green without this.
   */
  it('produces different instructions for every dial, moved alone', () => {
    for (const dial of DIAL_NAMES) {
      const low = brief(at({ [dial]: 0 } as Partial<Temperament>), [dial]);
      const high = brief(at({ [dial]: 1 } as Partial<Temperament>), [dial]);
      expect(low, `${dial} reads the same at 0 and 1`).not.toBe(high);
    }
  });

  it('states the raw number, so the three bands are not the only signal', () => {
    expect(brief(at({ creativity: 0.7 }), ['creativity'])).toContain('creativity — 0.70 of 1.00');
    expect(brief(at({ creativity: 0.75 }), ['creativity'])).toContain('creativity — 0.75 of 1.00');
  });

  it('is honest that the prose itself is banded', () => {
    // 0.70 and 0.75 select the same paragraph and differ only in the stated
    // number. Pinned rather than hidden: if the bands turn out to feel like
    // three modes wearing a slider, this is the test that has to change.
    const a = brief(at({ creativity: 0.7 }), ['creativity']);
    const b = brief(at({ creativity: 0.75 }), ['creativity']);
    expect(a).not.toBe(b);
    expect(a.replace('0.70', 'X')).toBe(b.replace('0.75', 'X'));
  });

  it('includes only the dials the operation asked for', () => {
    // `analyze` has no questions to ask; sending it `curiosity` would dilute the
    // instructions that matter, which costs more than the tokens.
    const scoped = brief(BALANCED_TEMPERAMENT, ['creativity', 'assertiveness']);
    expect(scoped).toContain('creativity —');
    expect(scoped).toContain('assertiveness —');
    expect(scoped).not.toContain('curiosity —');
    expect(scoped).not.toContain('technicality —');
  });

  it('carries the derived counts into the prose where they apply', () => {
    const bold = at({ creativity: 1, curiosity: 1 });
    const text = brief(bold);
    expect(text).toContain('about 4 distinct readings');
    expect(text).toContain('about 5 options per question');
  });
});

describe('what the briefing actually says at the extremes', () => {
  it('forbids invention at low creativity and demands it at high', () => {
    expect(brief(at({ creativity: 0 }), ['creativity'])).toContain(
      'Do not propose product ideas they have not raised',
    );
    expect(brief(at({ creativity: 1 }), ['creativity'])).toContain(
      'Treat every input as under-determined',
    );
  });

  it('inverts the assumption rule across the assertiveness range', () => {
    // The single most important behaviour change in the phase: the old prompt's
    // "an assumption is a LAST RESORT" survives at the bottom of the dial and is
    // explicitly contradicted at the top.
    expect(brief(at({ assertiveness: 0 }), ['assertiveness'])).toContain('a last resort');
    expect(brief(at({ assertiveness: 1 }), ['assertiveness'])).toContain('**not** a last resort');
  });

  it('bans jargon outright at low technicality', () => {
    expect(brief(at({ technicality: 0 }), ['technicality'])).toContain('No jargon at all');
  });
});
