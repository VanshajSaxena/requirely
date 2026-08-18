import type { z } from 'zod';
import type { Generated, GenerationRequest } from './generation.ts';

/**
 * The engine's primary capability: get a schema-shaped value out of a model.
 *
 * The schema is the contract. Model output is untrusted input, so every call
 * validates before the value reaches the domain — which is also why the engine
 * never parses free text or hand-rolls JSON extraction.
 *
 * Implementations must throw `CapabilityError` on failure so no vendor error
 * type crosses this boundary.
 */
export interface StructuredGenerator {
  generate<T>(schema: z.ZodType<T>, request: GenerationRequest): Promise<Generated<T>>;
}
