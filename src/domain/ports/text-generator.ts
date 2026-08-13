import type { Generated, GenerationRequest } from './generation.ts';

/**
 * Free-form prose, for projections whose output is a document rather than a
 * structure — the body of an SRS, or a prompt written for another agent to read.
 */
export interface TextGenerator {
  generate(request: GenerationRequest): Promise<Generated<string>>;
}
