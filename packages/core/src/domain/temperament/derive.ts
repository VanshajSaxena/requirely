import { DEFAULT_SUFFICIENCY_POLICY, type SufficiencyPolicy } from '../sufficiency/policy.ts';
import type { Temperament } from './temperament.ts';

/**
 * The counted half of a temperament.
 *
 * `briefing.ts` turns dials into prose, which is banded and therefore steps. This
 * is where a dial genuinely varies continuously: these numbers move with every
 * hundredth, and they are what a model is given as concrete instructions ("offer
 * 4 options") rather than as an adjective.
 *
 * Two dials drive numbers that **already existed** — `thoroughness` feeds
 * `SufficiencyPolicy`, `curiosity` feeds the per-turn question count — so those
 * two cost almost nothing to add. That is deliberate: it is much easier to defend
 * a dial that moves a number the system was already reading than one that only
 * changes an adjective in a prompt.
 */

export interface TemperamentCounts {
  /** Readings to propose where an input is genuinely ambiguous. 1–4. */
  readonly readingsPerInput: number;
  /** Answer options to offer where plausible answers exist. 2–5. */
  readonly optionsPerQuestion: number;
  /** Questions to ask in one turn, already clamped by the spend ceiling. 2–6. */
  readonly questionsPerTurn: number;
}

export interface CountCeilings {
  /**
   * `REQUIRELY_MAX_QUESTIONS_PER_TURN`.
   *
   * Required rather than defaulted, because forgetting to pass it would silently
   * remove a spend ceiling — and a caller that has to supply one cannot forget
   * that it exists.
   */
  readonly maxQuestionsPerTurn: number;
}

/** Rounded to two places so the numbers compare cleanly and read like settings. */
const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Dials to counts.
 *
 * **A dial may never raise a ceiling.** `questionsPerTurn` is clamped by config,
 * not merely influenced by it, for the same reason `MAX_OUTPUT_TOKENS` exists:
 * a knob that can increase spend without an explicit config change is how a
 * budget quietly stops being a budget. Turning curiosity to 1.0 asks for six
 * questions and gets `min(6, configured)`.
 */
export function countsFor(temperament: Temperament, ceilings: CountCeilings): TemperamentCounts {
  return {
    readingsPerInput: 1 + Math.round(3 * temperament.creativity),
    optionsPerQuestion: 2 + Math.round(3 * temperament.curiosity),
    questionsPerTurn: Math.min(
      2 + Math.round(4 * temperament.curiosity),
      ceilings.maxQuestionsPerTurn,
    ),
  };
}

/**
 * Dials to a sufficiency policy.
 *
 * Derived from a base rather than constructed, so `requiredDimensions` and
 * `weakCoverageBelow` stay where they are: neither is a matter of taste.
 * Which dimensions must have a Decision behind them is the product's definition
 * of "understood", and letting a slider erode it would make `sufficient` mean
 * something different in every session — which is exactly the unfalsifiable
 * verdict Phase 8 removed when it stopped letting the model score its own work.
 *
 * | thoroughness | ratio | stall after |
 * | ---: | ---: | ---: |
 * | 0.0 | 0.30 | 1 turn |
 * | 0.5 | 0.50 | 2 turns *(today's values)* |
 * | 1.0 | 0.70 | 3 turns |
 */
export function policyFor(
  temperament: Temperament,
  base: SufficiencyPolicy = DEFAULT_SUFFICIENCY_POLICY,
): SufficiencyPolicy {
  return {
    ...base,
    minimumSettledRatio: round2(0.3 + 0.4 * temperament.thoroughness),
    stallAfterTurnsWithoutProgress: 1 + Math.round(2 * temperament.thoroughness),
  };
}
