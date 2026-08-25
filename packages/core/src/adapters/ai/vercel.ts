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

/**
 * The shared body of every AI-SDK-backed adapter.
 *
 * `anthropic.ts` and `openai.ts` differ only in which model they resolve and how
 * they translate `effort` — everything else (calling `generateObject`, mapping
 * usage, translating errors) is identical, and duplicating it would mean two
 * places to fix the day a vendor error shape changes.
 *
 * This file and its two callers are the **only** places `ai`/`@ai-sdk/*` may be
 * imported; `scripts/check-boundaries.sh` rule 4 enforces that. Nothing above
 * this layer learns that the AI SDK exists.
 */

/**
 * How `effort` reaches a provider.
 *
 * This is the concrete test of a claim made three phases ago — that
 * `effort: 'low' | 'medium' | 'high'` is a *domain* concept ("how hard should
 * this think") rather than a vendor knob in disguise. Each provider spells it
 * differently, and the translation lives here rather than in the engine.
 */
export type EffortMapper = (effort: Effort | undefined) => Record<string, unknown>;

export interface VercelAdapterConfig {
  readonly provider: string;
  readonly model: LanguageModel;
  readonly modelId: string;
  readonly mapEffort: EffortMapper;
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
          ...(request.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: request.maxOutputTokens }),
          providerOptions: config.mapEffort(request.effort) as never,
        });

        return {
          value: result.object as T,
          usage: Usage.parse({
            operation: request.operation,
            provider: config.provider,
            model: config.modelId,
            inputTokens: result.usage.inputTokens ?? 0,
            outputTokens: result.usage.outputTokens ?? 0,
            // Cost needs a per-model price table this project does not have yet;
            // null is honest, and `sumUsage` already distinguishes it from zero.
            costMinorUnits: null,
          }),
        };
      } catch (error) {
        throw translate(error, config.provider, request);
      }
    },
  };
}

/**
 * Vendor error → `CapabilityError`.
 *
 * The `retryable` flag is the load-bearing part: `withValidationRetry` keys on
 * it, so only a schema disagreement comes back marked true. A 401 or a missing
 * key will not succeed on the second attempt — retrying it only spends the
 * user's money more slowly.
 */
function translate(error: unknown, provider: string, request: GenerationRequest): CapabilityError {
  if (NoObjectGeneratedError.isInstance(error)) {
    return new CapabilityError(
      request.operation,
      provider,
      `model did not produce output matching the schema${error.text === undefined ? '' : ` (returned: ${truncate(error.text)})`}`,
      { retryable: true, cause: error },
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return new CapabilityError(request.operation, provider, message, { cause: error });
}

const truncate = (text: string, limit = 300): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`;
