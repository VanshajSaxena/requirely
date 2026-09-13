import type {
  Understanding,
  UnderstandingAssessment,
  UnderstandingDelta,
  Usage,
} from '../domain/index.ts';
import type { AnalyzeContext } from './context.ts';
import { analyze, analyzeAndAssess, assess, type StepDeps } from './steps.ts';

/**
 * Two ways to spend a turn's model calls, same signature.
 *
 * `separate` (3 calls) scores the understanding the domain actually stored.
 * `merged` (2 calls) sends the understanding once and scores a predicted merge.
 *
 * Both exist so the token-versus-fidelity trade can be *measured* on a fixture
 * session rather than argued about — flip the config, re-run, compare recorded
 * usage. That is the only honest way to serve a token-usage priority.
 */

export interface AnalysisResult {
  readonly understanding: Understanding;
  readonly delta: UnderstandingDelta;
  readonly assessment: UnderstandingAssessment;
  readonly usage: readonly Usage[];
}

/**
 * Applies the delta and returns the next understanding.
 *
 * Passed *in* rather than having strategies return a delta for the caller to
 * apply. Applying twice would draw two different ID sequences from the same
 * IdGenerator and silently produce a revision whose IDs nothing else references
 * — so the callback makes double-application unexpressible instead of merely
 * discouraged.
 */
export type Merge = (delta: UnderstandingDelta) => Understanding;

export type AnalysisStrategy = (
  deps: StepDeps,
  context: AnalyzeContext,
  merge: Merge,
) => Promise<AnalysisResult>;

export const separateStrategy: AnalysisStrategy = async (deps, context, merge) => {
  const analyzed = await analyze(deps, context);
  const understanding = merge(analyzed.value);
  const assessed = await assess(deps, understanding, context.dials);

  return {
    understanding,
    delta: analyzed.value,
    assessment: assessed.value,
    usage: [analyzed.usage, assessed.usage],
  };
};

export const mergedStrategy: AnalysisStrategy = async (deps, context, merge) => {
  const result = await analyzeAndAssess(deps, context);

  return {
    understanding: merge(result.value.delta),
    delta: result.value.delta,
    assessment: result.value.assessment,
    usage: [result.usage],
  };
};

export const STRATEGIES = {
  separate: separateStrategy,
  merged: mergedStrategy,
} as const;

export type StrategyName = keyof typeof STRATEGIES;
