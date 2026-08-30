import { generateObject, type LanguageModel, NoObjectGeneratedError } from 'ai';
import type { z } from 'zod';
import {
  CapabilityError,
  type Effort,
  type Generated,
  type GenerationRequest,
  type StructuredGenerator,
  Usage,
} from '../../domain/index.ts';
import { costMinorUnitsFor } from './pricing.ts';

/**
 * The shared body of every AI-SDK-backed adapter.
 *
 * `anthropic.ts` and `openai.ts` differ only in which model they resolve —
 * everything else (calling `generateObject`, translating `effort`, mapping
 * usage, translating errors) is identical, and duplicating it would mean two
 * places to fix the day a vendor error shape changes.
 *
 * This file and its two callers are the **only** places `ai`/`@ai-sdk/*` may be
 * imported; `scripts/check-boundaries.sh` rule 4 enforces that. Nothing above
 * this layer learns that the AI SDK exists.
 */

/**
 * `effort` reaches every provider through one vendor-neutral setting.
 *
 * This replaced a per-vendor table, and the correction is worth understanding
 * because the original was **wrong in a way no test could see**. Anthropic's
 * mapper emitted `thinking: { type: 'enabled', budgetTokens: N }` — a form the
 * Claude 5 family rejects with an HTTP 400 — while Haiku 4.5 is the exact
 * opposite and *requires* it. The two model families have incompatible thinking
 * APIs, so no hand-written table is correct for both, and every test passed
 * because none of them made a real call.
 *
 * The SDK already solves this: `reasoning` is a spec-level call option, and
 * each provider maps it to whatever the *resolved model* actually accepts
 * (`@ai-sdk/anthropic` branches on `supportsAdaptiveThinking`; `@ai-sdk/openai`
 * falls back to it when `reasoningEffort` is unset). Correctness therefore
 * follows the model id, which is the only thing that knows.
 *
 * **This strengthens the Phase 4 claim rather than weakening it.** The evidence
 * that `effort` was a domain concept used to be "two vendors spell it
 * differently". The better evidence is that the SDK models *the same concept*
 * independently, at the spec layer, across every provider it supports — "how
 * hard should this think" is a capability, not an Anthropic parameter wearing a
 * generic name.
 *
 * The table is explicit rather than a pass-through even though the three values
 * coincide today: `Effort` and the SDK's set are different types (the SDK also
 * has `minimal`, `xhigh`, `none`, `provider-default`), so this records that we
 * chose three of seven, and a future divergence is a one-line edit here instead
 * of a type error at the call site.
 */
type ReasoningLevel = NonNullable<Parameters<typeof generateObject>[0]['reasoning']>;

const REASONING: Record<Effort, ReasoningLevel> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

/** Exported so the mapping is assertable without a network call or a mock model. */
export const reasoningFor = (effort: Effort | undefined): ReasoningLevel =>
  REASONING[effort ?? 'medium'];

export interface VercelAdapterConfig {
  readonly provider: string;
  readonly model: LanguageModel;
  readonly modelId: string;
  /**
   * Vendor-specific request options, chosen **per request** from the schema.
   *
   * This hook was deleted along with the per-vendor effort tables and came back
   * within the hour, which is worth recording rather than tidying away: the
   * stated criterion for re-adding it was "a genuinely vendor-specific need",
   * and one appeared on the first live call (see `anthropic.ts`). Deleting a
   * seam with no user was still right — the seam that returned carries a real
   * requirement instead of a hypothetical one.
   *
   * It takes the schema rather than being a static value because the need is
   * itself schema-dependent: Anthropic's structured-output mode has to change
   * for schemas above a size limit, and only two of our four are above it.
   */
  readonly providerOptionsFor?:
    | ((schema: z.ZodType<unknown>) => Record<string, Record<string, unknown>> | undefined)
    | undefined;
}

export function vercelStructuredGenerator(config: VercelAdapterConfig): StructuredGenerator {
  return {
    async generate<T>(schema: z.ZodType<T>, request: GenerationRequest): Promise<Generated<T>> {
      try {
        const result = await generateObject({
          model: config.model,
          schema,
          // `instructions` is stable per operation and `input` is the volatile
          // part, so providers that cache on a system prefix can do so.
          system: request.instructions,
          prompt: request.input,
          reasoning: reasoningFor(request.effort),
          ...withProviderOptions(config, schema),
          ...(request.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: request.maxOutputTokens }),
        });

        const inputTokens = result.usage.inputTokens ?? 0;
        const outputTokens = result.usage.outputTokens ?? 0;

        return {
          value: result.object as T,
          usage: Usage.parse({
            operation: request.operation,
            provider: config.provider,
            model: config.modelId,
            inputTokens,
            outputTokens,
            // null for a model the price table does not know — `sumUsage`
            // distinguishes that from a genuine zero, so an unpriced model
            // reads "cost unknown" rather than confidently reading "free".
            costMinorUnits: costMinorUnitsFor(config.modelId, inputTokens, outputTokens),
          }),
        };
      } catch (error) {
        throw translate(error, config.provider, request, config.modelId);
      }
    },
  };
}

/** Spread-or-omit, so an adapter with no vendor options sends no key at all. */
function withProviderOptions(
  config: VercelAdapterConfig,
  schema: z.ZodType<unknown>,
): Record<string, never> {
  const options = config.providerOptionsFor?.(schema);
  return (options === undefined ? {} : { providerOptions: options }) as Record<string, never>;
}

/**
 * Vendor error → `CapabilityError`.
 *
 * The `retryable` flag is the load-bearing part: `withValidationRetry` keys on
 * it, so only a schema disagreement comes back marked true. A 401 or a missing
 * key will not succeed on the second attempt — retrying it only spends the
 * user's money more slowly.
 */
function translate(
  error: unknown,
  provider: string,
  request: GenerationRequest,
  modelId: string,
): CapabilityError {
  if (NoObjectGeneratedError.isInstance(error)) {
    return new CapabilityError(
      request.operation,
      provider,
      `model did not produce output matching the schema${error.text === undefined ? '' : ` (returned: ${truncate(error.text)})`}`,
      // The provider billed for this attempt even though it is unusable, and
      // `NoObjectGeneratedError` carries what it cost. Passing it on is what
      // lets the retry decorator report the true price of a recovered call.
      { retryable: true, cause: error, ...spentOn(error, provider, request, modelId) },
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return new CapabilityError(request.operation, provider, message, { cause: error });
}

/** `{ usage }` when the provider reported what the failed attempt cost, else `{}`. */
function spentOn(
  error: {
    usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined;
  },
  provider: string,
  request: GenerationRequest,
  modelId: string,
): { usage?: Usage } {
  const inputTokens = error.usage?.inputTokens ?? 0;
  const outputTokens = error.usage?.outputTokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return {};

  return {
    usage: Usage.parse({
      operation: request.operation,
      provider,
      model: modelId,
      inputTokens,
      outputTokens,
      costMinorUnits: costMinorUnitsFor(modelId, inputTokens, outputTokens),
    }),
  };
}

const truncate = (text: string, limit = 300): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`;
