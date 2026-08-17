import { z } from 'zod';

/**
 * Names the capability invocation a call belongs to.
 *
 * This is not bookkeeping. It carries two jobs:
 *
 * 1. **Cost attribution.** `Turn.usage` becomes answerable at the step level —
 *    "assess was 40% of this session's spend" — which is what tells you *where*
 *    to optimize rather than just that you should.
 * 2. **Per-operation routing.** An adapter can send question generation to a
 *    cheap model and contradiction detection to an expensive one, without the
 *    engine knowing any model names.
 *
 * A `const` object rather than an `enum`: `erasableSyntaxOnly` forbids enums,
 * and this gives the same union type with none of the runtime baggage.
 */
export const OPERATION = {
  analyze: 'analyze',
  analyzeAndAssess: 'analyze-and-assess',
  assess: 'assess',
  generateQuestions: 'generate-questions',
  transcribe: 'transcribe',
  project: 'project',
} as const;

export type Operation = (typeof OPERATION)[keyof typeof OPERATION];

export const OperationSchema = z.enum([
  'analyze',
  'analyze-and-assess',
  'assess',
  'generate-questions',
  'transcribe',
  'project',
]);
