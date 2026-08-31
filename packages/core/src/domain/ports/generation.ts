import { z } from 'zod';
import type { Operation } from '../shared/operation.ts';
import type { Usage } from '../shared/usage.ts';

/**
 * How hard a call should think.
 *
 * This is a domain concept, not a vendor one: the engine knows that detecting
 * contradictions across sources deserves more deliberation than rephrasing a
 * question, and says so without naming a provider. Adapters map it onto whatever
 * their vendor calls it. Deleting this would not remove the concept — it would
 * just push a vendor's spelling of it into the engine.
 */
export const Effort = z.enum(['low', 'medium', 'high']);
export type Effort = z.infer<typeof Effort>;

/**
 * How a schema-shaped value was actually obtained.
 *
 * - **`constrained`** — the provider compiled the schema into a decoding grammar,
 *   so malformed output is not merely unlikely but unrepresentable. Strongest
 *   guarantee, and the one with hard limits: grammars cap how branchy a schema
 *   may be, and a large schema is simply refused.
 * - **`tool`** — the schema goes as an ordinary non-strict tool definition. No
 *   grammar, so no size limit, and no guarantee either; conformance moves to us.
 *   Some providers additionally forbid extended thinking in this mode.
 * - **`prompted`** — the schema is described *in the prompt* and the reply is
 *   ordinary text that we extract, repair and validate. Works against a provider
 *   with no structured-output feature at all, which is the point: it is the floor
 *   that keeps the core from assuming a capability.
 *
 * **This is telemetry, not a control input.** The adapter chooses the method by
 * measuring the schema against its own provider's limits; the engine reads which
 * one happened so the eval suite can compare cost and accuracy across them, and
 * never selects one. An engine that picked the method would be an engine that
 * knew what its provider could do.
 *
 * A domain type for the same reason `Effort` is: these are capability categories
 * every provider can be described in, not one vendor's parameter name.
 */
export const GenerationMethod = z.enum(['constrained', 'tool', 'prompted']);
export type GenerationMethod = z.infer<typeof GenerationMethod>;

/**
 * One request for a schema-shaped value.
 *
 * Named for the act rather than the transport: with three methods there is no
 * single "request" shape any more — one is a grammar, one is a tool definition,
 * one is a paragraph of prose — so what the engine hands over is *what it wants*
 * and the adapter decides how to ask for it.
 *
 * The schema and the examples travel together because they are one contract.
 * Passing the schema separately made it easy to add a method that needed
 * examples and forget to supply them, which fails as a *quality* regression
 * rather than a type error.
 */
export interface Elicitation<T> {
  /**
   * Which engine step this call serves. Required, not optional: it is what makes
   * spend attributable per step and what lets an adapter route models per
   * operation. An unnamed call is one you cannot account for later.
   */
  readonly operation: Operation;
  /** Stable, role-defining context. Adapters may cache on this prefix. */
  readonly instructions: string;
  /** The volatile part of the call. */
  readonly input: string;
  /**
   * The contract, and the only thing trusted to decide whether output is valid.
   *
   * Every method validates against it. A `constrained` call is *also* validated
   * — the provider's guarantee is about its own decoder, not about ours, and a
   * schema that round-trips through JSON Schema can lose a refinement on the way.
   */
  readonly schema: z.ZodType<T>;
  /**
   * Instances the model should imitate, in the shape the schema accepts as input.
   *
   * Only `prompted` reads them, and that is the method with no structural
   * guarantee at all — so this is where a worked example does the work a grammar
   * would otherwise do. Ignored by the other two, deliberately: paying tokens for
   * an example a decoder already enforces is spending to restate a certainty.
   */
  readonly examples?: readonly unknown[] | undefined;
  readonly effort?: Effort | undefined;
  readonly maxOutputTokens?: number | undefined;
}

export interface Generated<T> {
  readonly value: T;
  readonly usage: Usage;
  /** Which method produced this. Observation only — see `GenerationMethod`. */
  readonly method: GenerationMethod;
  /**
   * The model's literal output, when the method exposed it.
   *
   * `null` for `constrained` and `tool`, where the SDK hands back an already
   * parsed object and there is no raw text to keep. Re-serializing the parsed
   * value and calling it "raw" would be a plausible lie in exactly the place a
   * later reader would trust it.
   */
  readonly raw: string | null;
  /**
   * What had to be done to make the output parse, in order. Empty on a clean call.
   *
   * A success that took three repairs must be distinguishable from one that took
   * none; without this, "prompted mode works fine" is unfalsifiable.
   */
  readonly repairs: readonly string[];
}
