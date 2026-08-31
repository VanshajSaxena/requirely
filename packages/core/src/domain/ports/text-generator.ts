import type { Elicitation, Generated } from './generation.ts';

/**
 * Free-form prose, for projections whose output is a document rather than a
 * structure — the body of an SRS, or a prompt written for another agent to read.
 *
 * Takes an `Elicitation` minus its contract: there is no schema to satisfy, so
 * `schema` and `examples` are exactly the fields that do not apply. Deriving it
 * with `Omit` rather than restating the shape means a new field on `Elicitation`
 * — a spend ceiling, a cache hint — reaches this port automatically instead of
 * quietly not applying to it.
 */
export type TextRequest = Omit<Elicitation<string>, 'schema' | 'examples'>;

export interface TextGenerator {
  generate(request: TextRequest): Promise<Generated<string>>;
}
