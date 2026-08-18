import { z } from 'zod';
import {
  type Generated,
  OPERATION,
  type QuestionDraft,
  QuestionDraft as QuestionDraftSchema,
  type StructuredGenerator,
  type SufficiencyVerdict,
  type Understanding,
  UnderstandingAssessment,
  UnderstandingDelta,
} from '../domain/index.ts';
import {
  type AnalyzeContext,
  buildAnalyzeInput,
  buildAssessInput,
  buildQuestionsInput,
} from './context.ts';
import { ANALYZE_INSTRUCTIONS, ASSESS_INSTRUCTIONS, QUESTIONS_INSTRUCTIONS } from './prompts.ts';

/**
 * The three model-facing operations, each a thin wrapper: build input, call the
 * port, return the validated value plus its usage.
 *
 * Deliberately thin. Anything that decides something belongs in the domain, and
 * anything that shapes context belongs in `context.ts`. What is left here is
 * only the wiring — which is why swapping providers changes nothing in this file.
 */

export interface StepDeps {
  readonly generator: StructuredGenerator;
}

/** Effort is a domain-level knob; adapters map it onto whatever their vendor calls it. */
const EFFORT = {
  /** Contradiction detection and cross-source reasoning is the hardest thing here. */
  analyze: 'high',
  assess: 'medium',
  questions: 'medium',
} as const;

export async function analyze(
  deps: StepDeps,
  context: AnalyzeContext,
): Promise<Generated<UnderstandingDelta>> {
  return deps.generator.generate(UnderstandingDelta, {
    operation: OPERATION.analyze,
    instructions: ANALYZE_INSTRUCTIONS,
    input: buildAnalyzeInput(context),
    effort: EFFORT.analyze,
  });
}

export async function assess(
  deps: StepDeps,
  understanding: Understanding,
): Promise<Generated<UnderstandingAssessment>> {
  return deps.generator.generate(UnderstandingAssessment, {
    operation: OPERATION.assess,
    instructions: ASSESS_INSTRUCTIONS,
    input: buildAssessInput(understanding),
    effort: EFFORT.assess,
  });
}

/**
 * The merged shape: one call returns both the delta and the assessment.
 *
 * Note what this costs semantically — the assessment describes an understanding
 * the model is *predicting* it will produce, since the merge has not happened
 * yet and the domain may reject part of the delta. That is the trade the
 * `merged` strategy makes in exchange for sending the understanding once.
 */
export const AnalyzeAndAssessResult = z.object({
  delta: UnderstandingDelta,
  assessment: UnderstandingAssessment,
});
export type AnalyzeAndAssessResult = z.infer<typeof AnalyzeAndAssessResult>;

export async function analyzeAndAssess(
  deps: StepDeps,
  context: AnalyzeContext,
): Promise<Generated<AnalyzeAndAssessResult>> {
  return deps.generator.generate(AnalyzeAndAssessResult, {
    operation: OPERATION.analyzeAndAssess,
    instructions: `${ANALYZE_INSTRUCTIONS}\n\n---\n\n${ASSESS_INSTRUCTIONS}\n\nAssess the understanding as it will be AFTER your delta is applied.`,
    input: buildAnalyzeInput(context),
    effort: EFFORT.analyze,
  });
}

const QuestionDrafts = z.object({ questions: z.array(QuestionDraftSchema) });

export async function generateQuestions(
  deps: StepDeps,
  understanding: Understanding,
  verdict: SufficiencyVerdict,
  maxQuestions: number,
): Promise<Generated<readonly QuestionDraft[]>> {
  const result = await deps.generator.generate(QuestionDrafts, {
    operation: OPERATION.generateQuestions,
    instructions: QUESTIONS_INSTRUCTIONS,
    input: buildQuestionsInput(understanding, verdict, maxQuestions),
    effort: EFFORT.questions,
  });
  return { value: result.value.questions, usage: result.usage };
}
