import type { Elicitation, Generated } from './generation.ts';

/**
 * The engine's primary capability: get a schema-shaped value out of a model.
 *
 * The schema is the contract. Model output is untrusted input, so every call
 * validates before the value reaches the domain — which is also why the engine
 * never parses free text or hand-rolls JSON extraction.
 *
 * **One argument, not two.** The schema used to be a separate parameter, which
 * was right while there was exactly one way to ask. With three generation
 * methods the schema travels with its examples as a single contract, and the
 * adapter decides how to render it. An implementation that cannot constrain
 * decoding is still a valid implementation of this interface.
 *
 * Implementations must throw `CapabilityError` on failure so no vendor error
 * type crosses this boundary.
 */
export interface StructuredGenerator {
  generate<T>(elicitation: Elicitation<T>): Promise<Generated<T>>;
}
