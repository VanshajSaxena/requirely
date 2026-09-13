import type { TemperamentCounts } from './derive.ts';
import { type Band, bandOf, type DialName, type Temperament } from './temperament.ts';

/**
 * Dials to instructions.
 *
 * All three wirings the owner asked for, in one string: **graded prose** for what
 * cannot be interpolated, **scaled counts** for what can, and **the number stated
 * outright** so the model has the fine grain the bands lose.
 *
 * Deliberately *not* wired: the provider's sampling temperature. It is what the
 * word literally means and it would confound the dial by construction — prose,
 * counts and sampling would all move together, and no experiment could ever
 * attribute an effect to any of them. This repo has reversed two decisions
 * (`text` → `timestamptz`, UUID → short ids) by being able to attribute, and
 * that is worth more here than a fourth mechanism.
 *
 * ## Why each dial names its own scope
 *
 * `assertiveness` decides whether an uncertainty becomes a question **at all**;
 * `curiosity` decides how many and how rich, **given that it is being asked**.
 * Worded that way on purpose: the alternative — "ask less" against "ask more" —
 * would read as a contradiction at high-assertive/high-curious, which is a real
 * and useful combination (decide a lot *and* ask a lot: a very active partner).
 *
 * ## Operation-scoped
 *
 * Callers pass the dials their operation actually uses. `analyze` has no
 * questions to ask, so sending it `curiosity` would spend tokens diluting the
 * instructions that matter. The dilution is the real cost, not the tokens.
 */

type Prose = (counts: TemperamentCounts) => string;

const BANDS: Record<DialName, Record<Band, Prose>> = {
  creativity: {
    low: () =>
      'Stay close to what the user actually said. Do not propose product ideas they have not raised. Where an input admits more than one reading, that ambiguity is itself worth asking about — do not resolve it by quietly picking one.',
    mid: () =>
      'Where an input plainly admits more than one reading, name the likeliest one or two and say which you are working from. Do not invent whole features; do make the implicit explicit.',
    high: (counts) =>
      `Treat every input as under-determined, because it is: a person describing what they want is describing the part they have words for. Work out what they might actually mean and put those readings on the table — including ones they have not thought of yet. Where an input is genuinely open, carry about ${counts.readingsPerInput} distinct readings rather than collapsing to one. Being wrong in an interesting way is more useful here than being right in a trivial one: correcting a proposal costs the user a sentence, and inventing one costs them the afternoon they do not have.`,
  },

  assertiveness: {
    low: () =>
      'Settle only what the input settles outright. An assumption is a last resort — prefer an open item that gets a question.',
    mid: () =>
      'Settle what is clearly implied, not only what is stated. Where a hole must be filled to describe the work at all, record an assumption carrying its `basis` and `risk` rather than leaving the description impossible.',
    high: () =>
      'Take positions. An assumption here is **not** a last resort; it is a first draft the user can veto. Where something is unsettled and you have a defensible view, write it down as an assumption with its `basis` and `risk`, and move on. Reserve questions for what you genuinely cannot infer, or where guessing wrong would be expensive to undo. Disagreeing with something you wrote costs the user one word; facing an empty question costs them the thinking you were supposed to do for them.',
  },

  technicality: {
    low: () =>
      "Write for someone who knows their business deeply and does not write software. No jargon at all — not 'non-functional requirement', not 'schema', not 'idempotent'. Say what a thing does in the words the user's own customers would use. Where a technical constraint matters, give the consequence rather than the mechanism.",
    mid: () =>
      "Write for a product manager: plain language, though 'integration', 'workflow' and 'permission' are fine. Avoid implementation vocabulary.",
    high: () =>
      'Write for an engineer. Requirements-engineering vocabulary is appropriate, and precision is worth more than approachability.',
  },

  thoroughness: {
    low: () =>
      'Aim at a workable first description rather than a complete one. Leaving something open is fine while the shape is clear.',
    mid: () =>
      'Cover the main paths properly. Edge cases may stay open unless they change the shape of the thing.',
    high: () =>
      'Do not treat something as understood while a required dimension is thin. Probe failure modes, boundaries, and how anyone would know it had been built correctly.',
  },

  curiosity: {
    low: (counts) =>
      `When you do ask, ask narrowly: the fewest, highest-value questions, with about ${counts.optionsPerQuestion} options each. One well-chosen question beats three adequate ones.`,
    mid: (counts) =>
      `When you do ask, offer about ${counts.optionsPerQuestion} options per question where plausible answers exist.`,
    high: (counts) =>
      `When you do ask, ask well and ask broadly: about ${counts.optionsPerQuestion} options per question, and prefer covering several dimensions over drilling into one. The user would rather click through several good questions than read a document built on guesses.`,
  },
};

const HEADER = `
## How to work on this session

The user set the dials below. They describe **how to think**, not what is true.
Where a dial and your own instinct disagree, the dial wins — it is the user
telling you what kind of help they want from you.
`.trim();

/**
 * The briefing for one operation.
 *
 * **Append this to a prompt, never prepend it.** `adapters/ai/vercel.ts` sends
 * `instructions` as the system prompt and notes that it is *"stable per
 * operation … so providers that cache on a system prefix can do so"*. A
 * per-session block at the front would void that cache for every session without
 * anything failing — `briefing.test.ts` pins the prefix property so the claim in
 * that comment stays true rather than quietly becoming false.
 */
export function temperamentBriefing(
  temperament: Temperament,
  dials: readonly DialName[],
  counts: TemperamentCounts,
): string {
  const sections = dials.map((dial) => {
    const value = temperament[dial];
    const prose = BANDS[dial][bandOf(value)](counts);
    // The raw figure alongside the prose: the bands are three steps wide, and
    // stating the number is what gives the model the grain between them.
    return `**${dial} — ${value.toFixed(2)} of 1.00**\n${prose}`;
  });

  return [HEADER, ...sections].join('\n\n');
}
