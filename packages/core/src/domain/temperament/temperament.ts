import { z } from 'zod';

/**
 * How Requirely should work on a session, as five numbers.
 *
 * ## Why numbers rather than modes
 *
 * The product has to serve people with very different clarity, taste and
 * vocabulary, and an enum of named modes forces every user into whichever one
 * fits worst. A vector composes: the two personas that prompted this differ on
 * exactly one dial and agree on the rest, which is an argument no enum can make.
 *
 * ```
 * explorer    { 0.9, 0.7, 0.6, 0.4, 0.7 }   ideas, no time — needs expansion
 * translator  { 0.8, 0.8, 0.1, 0.5, 0.5 }   deep domain, no code — needs translation
 *                        ^^^ the only real difference
 * ```
 *
 * ## The rule that keeps this from becoming a settings page
 *
 * **A dial earns its place only if it changes a specific, nameable behaviour.**
 * Every one of these five does, and `briefing.ts` / `derive.ts` are where you can
 * read exactly what. A dial nobody can point at the effect of is a placebo knob,
 * and `briefing.test.ts` asserts that two temperaments produce different
 * instructions precisely so one cannot ship.
 *
 * That test is not paranoia. `engine/prompts.ts` carried the sentence *"You are
 * not a question-asking machine"* **twice** — top and bottom of the same prompt —
 * and the questions stayed interrogatory anyway. Prompt pleading loses to
 * structural incentive, so a knob is assumed inert until measured otherwise.
 *
 * ## Static, for now
 *
 * Set once per session. The base is built so per-request variation is additive:
 * nothing reads a dial from a global, `Turn` records the temperament it ran
 * under, and every derivation is a pure function of the vector.
 */

/** Every dial runs 0 to 1. Out of range is a programming error, not a clamp. */
export const Dial = z.number().min(0).max(1);
export type Dial = z.infer<typeof Dial>;

export const Temperament = z.object({
  /**
   * How far past the user's literal words Requirely will reach.
   *
   * The dial for *"based on every input there will be multiple possibilities of
   * what he might actually mean; Requirely's job is to infer that."* At the top
   * band it proposes several readings of an ambiguous input; at the bottom it
   * treats the ambiguity as something to ask about instead.
   */
  creativity: Dial.default(0.5),
  /**
   * How much it settles without asking.
   *
   * Governs the `Assumption` tier, which has existed since Phase 8 and which the
   * prompt forbade with *"an assumption is a LAST RESORT"*. High assertiveness
   * inverts that: an assumption becomes a first draft the user can veto in one
   * word, which is cheaper for them than an empty question.
   */
  assertiveness: Dial.default(0.5),
  /**
   * Vocabulary register, and nothing else.
   *
   * Deliberately orthogonal to the other four: a staff engineer with a rough idea
   * and a marketing lead with deep domain knowledge can both want maximum
   * inference and opposite words back. One axis could not separate them.
   */
  technicality: Dial.default(0.5),
  /**
   * How high the bar for "enough" is.
   *
   * Drives numbers that already exist — `minimumSettledRatio` and
   * `stallAfterTurnsWithoutProgress` — rather than new prompt behaviour. Distinct
   * from `assertiveness`: one asks *will you decide without me*, this asks *how
   * much must be settled before you call it done*. High-assertive/low-thorough
   * decides fast against a low bar; the inverse asks a lot against a high one.
   */
  thoroughness: Dial.default(0.5),
  /**
   * How many questions, and how rich each one is.
   *
   * Composes with `assertiveness` rather than contradicting it, and the prose in
   * `briefing.ts` is worded to keep that true: assertiveness decides whether an
   * uncertainty becomes a question *at all*; curiosity decides how many and how
   * broad, given that it is being asked.
   */
  curiosity: Dial.default(0.5),
});
export type Temperament = z.infer<typeof Temperament>;

/**
 * Dial names, derived from the schema rather than declared beside it.
 *
 * One source of truth: adding a dial to the object above adds it here, and there
 * is no second list to forget. A hand-written union would compile perfectly while
 * silently omitting a dial from every briefing that iterates these.
 */
export type DialName = keyof Temperament;
export const DIAL_NAMES = Object.keys(Temperament.shape) as readonly DialName[];

/** Neutral on every dial. `Temperament.parse({})` produces exactly this. */
export const BALANCED_TEMPERAMENT: Temperament = Temperament.parse({});

/**
 * Named vectors, because five sliders is a barrier for the person who needs this
 * most — the one who *"doesn't know how to code nor has any idea how to use AI"*.
 *
 * A preset is a starting point, not a mode: individual dials override it, and
 * nothing downstream ever learns which preset a vector came from.
 *
 * **`balanced` is a behaviour change, not a neutral default.** Today's prompts
 * sit at roughly creativity 0.1 / assertiveness 0.1 — they say so in words
 * ("be conservative", "a last resort"). Moving the resting state to 0.5 is the
 * point of the phase, and calling it "the default" should not disguise that.
 */
export const TEMPERAMENT_PRESETS = {
  balanced: BALANCED_TEMPERAMENT,
  /** Ideas and no time: expand what was said into what it might mean. */
  explorer: Temperament.parse({
    creativity: 0.9,
    assertiveness: 0.7,
    technicality: 0.6,
    thoroughness: 0.4,
    curiosity: 0.7,
  }),
  /** Deep domain knowledge, no technical vocabulary: translate it into buildable terms. */
  translator: Temperament.parse({
    creativity: 0.8,
    assertiveness: 0.8,
    technicality: 0.1,
    thoroughness: 0.5,
    curiosity: 0.5,
  }),
  /** "I have a spec — organise it." Capture fidelity, which is where the product was. */
  scribe: Temperament.parse({
    creativity: 0.1,
    assertiveness: 0.2,
    technicality: 0.9,
    thoroughness: 0.8,
    curiosity: 0.6,
  }),
} as const satisfies Record<string, Temperament>;

export type TemperamentPreset = keyof typeof TEMPERAMENT_PRESETS;
export const TEMPERAMENT_PRESET_NAMES = Object.keys(
  TEMPERAMENT_PRESETS,
) as readonly TemperamentPreset[];

/**
 * Which third of the range a dial sits in.
 *
 * Three bands, because prose cannot be interpolated and three is the most that
 * stays distinguishable when written out. **This is where the continuity is
 * lost** — 0.70 and 0.75 select the same paragraph — and the honest answer is
 * that the counted half of the derivation (`derive.ts`) is where a dial varies
 * smoothly. Recorded rather than hidden: if the bands turn out to feel like three
 * modes wearing a slider, that is the thing to fix.
 */
export type Band = 'low' | 'mid' | 'high';

export const bandOf = (value: number): Band =>
  value <= 0.33 ? 'low' : value <= 0.66 ? 'mid' : 'high';
