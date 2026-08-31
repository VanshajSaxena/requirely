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
  type UnderstandingDelta,
} from '../domain/index.ts';
import { UnderstandingDeltaCodec } from '../wire/index.ts';
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
 *
 * **`analyze` sends `UnderstandingDeltaCodec`, not `UnderstandingDelta`.** A
 * codec's input side is the wire and its output side is the domain, so the
 * generator emits a flat, sentinel-encoded schema and hands back an ordinary
 * domain delta. `Generated<UnderstandingDelta>` is unchanged; only the schema
 * the provider sees is different, and nothing below this line learns that.
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

/**
 * An output ceiling per operation. **Not a tuning knob — a spend ceiling.**
 *
 * Discovered by the first live request, which failed on auth and therefore cost
 * nothing but printed the outgoing body: with `maxOutputTokens` unset the SDK
 * falls back to the *model's* maximum, and derives the extended-thinking budget
 * from it as `maxOutputTokens x pct` (`low` 0.1, `medium` 0.3, `high` 0.6). On
 * `claude-haiku-4-5` that meant `max_tokens: 64000` and a 38,400-token thinking
 * budget for a one-sentence brief. A three-call turn was therefore bounded only
 * by 192k output tokens — about $0.96 on Haiku and **$4.80 on `claude-opus-5`**,
 * which is an entire small balance in a single turn.
 *
 * Two consequences shape the numbers below:
 *
 * - **This is the *answer* budget; thinking is added on top.** The SDK sends
 *   `max_tokens = maxOutputTokens + thinkingBudget`, so a 4,000 cap at `medium`
 *   effort really permits 5,200. An earlier draft of this comment had it
 *   backwards — it claimed thinking ate into the ceiling and sized each cap by
 *   dividing by `(1 - pct)` — and the first live run disproved it by returning
 *   4,869 output tokens against a "4,000" cap. Corrected here rather than
 *   quietly, because the wrong version made every number look too small.
 * - **A ceiling is not a spend.** These are worst cases. Measured on the first
 *   live session: 7,188 and 9,223 output tokens per turn against a ~22,400
 *   worst case, so roughly a third. The point is that the worst case is now
 *   knowable in advance.
 *
 * Sized from what each operation actually emits, with the first live run's
 * numbers in brackets.
 */
const MAX_OUTPUT_TOKENS = {
  /**
   * Was "thinking is off here" — that was true only while the delta schema was
   * too branchy to compile, which forced `jsonTool` mode and forbade thinking.
   * The wire codec brought it back under the caps, so `effort: 'high'` reaches
   * the model again and the answer budget now shares the request with a
   * thinking budget added on top. [382, 434 without thinking]
   */
  analyze: 8_000,
  /** Delta plus assessment in one response. */
  analyzeAndAssess: 14_000,
  /** Eight dimensions with rationales plus a summary is well under 1k. */
  assess: 4_000,
  /** Four questions with options and elaborations is well under 1k. */
  questions: 4_000,
} as const;

export async function analyze(
  deps: StepDeps,
  context: AnalyzeContext,
): Promise<Generated<UnderstandingDelta>> {
  return deps.generator.generate(UnderstandingDeltaCodec, {
    operation: OPERATION.analyze,
    instructions: ANALYZE_INSTRUCTIONS,
    input: buildAnalyzeInput(context),
    effort: EFFORT.analyze,
    maxOutputTokens: MAX_OUTPUT_TOKENS.analyze,
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
    maxOutputTokens: MAX_OUTPUT_TOKENS.assess,
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
  delta: UnderstandingDeltaCodec,
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
    maxOutputTokens: MAX_OUTPUT_TOKENS.analyzeAndAssess,
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
    maxOutputTokens: MAX_OUTPUT_TOKENS.questions,
  });
  return { value: result.value.questions, usage: result.usage };
}
