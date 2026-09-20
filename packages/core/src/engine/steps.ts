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
import { DELTA_EXAMPLE, UnderstandingDeltaCodec } from '../wire/index.ts';
import {
  type AnalyzeContext,
  buildAnalyzeInput,
  buildAssessInput,
  buildQuestionsInput,
} from './context.ts';
import {
  analyzeAndAssessInstructions,
  analyzeInstructions,
  assessInstructions,
  type Dialled,
  questionsInstructions,
} from './prompts.ts';

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
  /** Four questions with explained options is well under 1k. */
  questions: 4_000,
} as const;

export async function analyze(
  deps: StepDeps,
  context: AnalyzeContext,
): Promise<Generated<UnderstandingDelta>> {
  return deps.generator.generate({
    operation: OPERATION.analyze,
    instructions: analyzeInstructions(context.dials),
    input: buildAnalyzeInput(context),
    schema: UnderstandingDeltaCodec,
    // Read only by `prompted` generation, which has no structural guarantee to
    // fall back on. The delta is the one schema where a worked example does real
    // work: sixteen always-present fields per op are obvious in an example and
    // laborious in prose.
    examples: [DELTA_EXAMPLE],
    effort: EFFORT.analyze,
    maxOutputTokens: MAX_OUTPUT_TOKENS.analyze,
  });
}

export async function assess(
  deps: StepDeps,
  understanding: Understanding,
  dials: Dialled,
): Promise<Generated<UnderstandingAssessment>> {
  return deps.generator.generate({
    operation: OPERATION.assess,
    instructions: assessInstructions(dials),
    input: buildAssessInput(understanding),
    schema: UnderstandingAssessment,
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
  return deps.generator.generate({
    schema: AnalyzeAndAssessResult,
    examples: [{ delta: DELTA_EXAMPLE, assessment: ASSESSMENT_EXAMPLE }],
    operation: OPERATION.analyzeAndAssess,
    instructions: analyzeAndAssessInstructions(context.dials),
    input: buildAnalyzeInput(context),
    effort: EFFORT.analyze,
    maxOutputTokens: MAX_OUTPUT_TOKENS.analyzeAndAssess,
  });
}

/**
 * Exported so `adapters/ai/caps.test.ts` can measure it.
 *
 * That test checks every operation's emitted schema against every provider's
 * caps, and it can only do that if it can reach the schemas. A private const
 * here is exactly how `generate-questions` sat at six optional properties
 * without anyone noticing it was unusable on OpenAI.
 */
export const QuestionDrafts = z.object({ questions: z.array(QuestionDraftSchema) });

/**
 * A minimal, valid assessment, for the merged operation's prompted rendering.
 *
 * Two dimensions rather than all eight: an example teaches the *shape*, and
 * paying for six more rows of the same shape is paying to restate it.
 */
const ASSESSMENT_EXAMPLE = {
  summary: 'Purpose is clear; acceptance criteria are not.',
  blockingItemIds: [],
  coverage: [
    { dimension: 'purpose', score: 0.9, rationale: 'The brief states the goal directly.' },
    { dimension: 'acceptance', score: 0.2, rationale: 'Nothing states how success is measured.' },
  ],
};

export async function generateQuestions(
  deps: StepDeps,
  understanding: Understanding,
  verdict: SufficiencyVerdict,
  maxQuestions: number,
  dials: Dialled,
): Promise<Generated<readonly QuestionDraft[]>> {
  const result = await deps.generator.generate({
    operation: OPERATION.generateQuestions,
    instructions: questionsInstructions(dials),
    input: buildQuestionsInput(understanding, verdict, maxQuestions),
    schema: QuestionDrafts,
    effort: EFFORT.questions,
    maxOutputTokens: MAX_OUTPUT_TOKENS.questions,
  });
  // Unwrapping the envelope loses nothing: `method`, `raw` and `repairs` travel
  // with the call, not with the value inside it.
  return { ...result, value: result.value.questions };
}
