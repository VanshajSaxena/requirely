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

export interface GenerationRequest {
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
  readonly effort?: Effort | undefined;
  readonly maxOutputTokens?: number | undefined;
}

export interface Generated<T> {
  readonly value: T;
  readonly usage: Usage;
}
