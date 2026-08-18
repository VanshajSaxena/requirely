import type { Usage } from '../shared/usage.ts';

/**
 * Defined in v1, deliberately unimplemented.
 *
 * Retrieval is not needed while sources fit in context, but it becomes necessary
 * the moment someone ingests a two-hour recording or a whole repository. Naming
 * the capability now means the engine's future retrieval step has a seam to
 * depend on, and the pgvector-capable database image is already in place.
 *
 * The absence of an implementation is the point: this is a placed seam, not a
 * dead interface.
 */
export interface Embedder {
  embed(texts: readonly string[]): Promise<{
    readonly vectors: readonly (readonly number[])[];
    readonly usage: Usage;
  }>;
}
