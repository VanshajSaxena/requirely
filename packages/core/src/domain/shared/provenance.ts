import { z } from 'zod';
import { SourceId } from './ids.ts';

/**
 * Where a claim came from.
 *
 * Quote-based rather than offset-based: character offsets are more precise, but
 * models produce them unreliably, and a wrong offset silently cites the wrong
 * text. A verbatim quote can be located in the source's normalized text after
 * the fact, and when it cannot be found the citation degrades to "this source"
 * instead of pointing somewhere false.
 */
export const Provenance = z.object({
  sourceId: SourceId,
  /** Verbatim excerpt supporting the claim, when one exists. */
  quote: z.string().min(1).nullable().default(null),
  /** Used when the claim is inferred across a source rather than stated in it. */
  note: z.string().min(1).nullable().default(null),
});
export type Provenance = z.infer<typeof Provenance>;
