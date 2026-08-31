import { generateObject, generateText, type LanguageModel, NoObjectGeneratedError } from 'ai';
import { z } from 'zod';
import {
  CapabilityError,
  type Effort,
  type Elicitation,
  type Generated,
  type GenerationMethod,
  type StructuredGenerator,
  Usage,
} from '../../domain/index.ts';
import type { MethodChoice } from './method.ts';
import { costMinorUnitsFor } from './pricing.ts';
import { repairToValid } from './repair.ts';

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
 *
 * ## Three ways to ask, one port
 *
 * `constrained` and `tool` both go through `generateObject` and differ only in a
 * provider option; `prompted` goes through `generateText` and does its own
 * extraction and validation. The caller sees one `generate()` either way, and
 * `Generated.method` records which happened.
 *
 * **`prompted` is what makes the port a port.** Without it, `StructuredGenerator`
 * silently requires a provider with a structured-output feature — an abstraction
 * that only abstracts over vendors that already agree. With it, the floor is
 * "can produce text", which every model clears.
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
   * How this provider decides to ask, measured per request.
   *
   * Replaces a `providerOptionsFor` hook that returned only vendor options: with
   * three methods the decision and the options it implies are one thing, and
   * splitting them let a caller pick `jsonTool` without recording that it had.
   * Omitted means "always constrained", which is right for a fake or a mock.
   */
  readonly methodFor?: ((schema: z.ZodType<unknown>, effort: Effort) => MethodChoice) | undefined;
  /**
   * Vendor request options for a chosen method.
   *
   * Separate from `methodFor` because the mapping is mechanical once the method
   * is known — `constrained` → `outputFormat`, `tool` → `jsonTool` — while the
   * *choice* is a measurement. Keeping them apart is what lets `chooseMethod` be
   * a pure function with no vendor vocabulary in it.
   */
  readonly optionsFor?:
    | ((method: GenerationMethod) => Record<string, Record<string, unknown>> | undefined)
    | undefined;
}

export function vercelStructuredGenerator(config: VercelAdapterConfig): StructuredGenerator {
  return {
    async generate<T>(elicitation: Elicitation<T>): Promise<Generated<T>> {
      const effort = elicitation.effort ?? 'medium';
      const choice: MethodChoice | undefined = config.methodFor?.(
        elicitation.schema as z.ZodType<unknown>,
        effort,
      );
      const method = choice?.method ?? 'constrained';

      try {
        return method === 'prompted'
          ? await viaPrompt(config, elicitation, effort)
          : await viaObject(config, elicitation, effort, method);
      } catch (error) {
        throw translate(error, config.provider, elicitation, config.modelId);
      }
    },
  };
}

/**
 * `constrained` and `tool`: the SDK renders the schema and validates the reply.
 *
 * Passing `elicitation.schema` straight through is what makes the wire codec
 * work with no adapter change — `@ai-sdk/provider-utils` converts with
 * `io: 'input'` and validates with `safeParseAsync`, so a codec emits the wire
 * schema and returns a decoded domain value.
 */
async function viaObject<T>(
  config: VercelAdapterConfig,
  elicitation: Elicitation<T>,
  effort: Effort,
  method: GenerationMethod,
): Promise<Generated<T>> {
  // Spread-or-omit through a `Record<string, never>` cast: under
  // `exactOptionalPropertyTypes` an inline `{ k: v } | {}` spread produces an
  // optional property the SDK's option type will not accept.
  const options = config.optionsFor?.(method);
  const providerOptions = (options === undefined ? {} : { providerOptions: options }) as Record<
    string,
    never
  >;
  const ceiling = (
    elicitation.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: elicitation.maxOutputTokens }
  ) as Record<string, never>;

  const result = await generateObject({
    model: config.model,
    schema: elicitation.schema,
    // `instructions` is stable per operation and `input` is the volatile
    // part, so providers that cache on a system prefix can do so.
    system: elicitation.instructions,
    prompt: elicitation.input,
    reasoning: reasoningFor(effort),
    ...providerOptions,
    ...ceiling,
  });

  return {
    value: result.object as T,
    usage: usageOf(config, elicitation, result.usage),
    method,
    // No raw text to keep: the SDK hands back a parsed object. Re-serializing it
    // and calling that "raw" would be a lie in the place a reader would trust it.
    raw: null,
    repairs: [],
  };
}

/**
 * `prompted`: describe the schema in words, take text back, and repair it.
 *
 * The floor of the ladder, and the reason `StructuredGenerator` is a real
 * abstraction rather than a shared spelling for two vendors that already agree.
 * Everything the other two get from the provider — rendering, extraction,
 * validation — happens here instead.
 */
async function viaPrompt<T>(
  config: VercelAdapterConfig,
  elicitation: Elicitation<T>,
  effort: Effort,
): Promise<Generated<T>> {
  const ceiling = (
    elicitation.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: elicitation.maxOutputTokens }
  ) as Record<string, never>;

  const result = await generateText({
    model: config.model,
    system: `${elicitation.instructions}\n\n${renderContract(elicitation)}`,
    prompt: elicitation.input,
    reasoning: reasoningFor(effort),
    ...ceiling,
  });

  const usage = usageOf(config, elicitation, result.usage);
  let parsed: z.ZodSafeParseResult<T> | undefined;

  const repaired = repairToValid(result.text, (candidate) => {
    parsed = elicitation.schema.safeParse(candidate);
    return parsed.success;
  });

  if (!repaired.ok || parsed === undefined || !parsed.success) {
    // `retryable: true` and the usage attached, exactly as the object path does:
    // a prompted failure is a schema disagreement like any other, and it was
    // billed like any other.
    throw new CapabilityError(
      elicitation.operation,
      config.provider,
      `prompted output did not satisfy the schema${
        parsed?.success === false ? ` (${parsed.error.issues[0]?.message ?? 'invalid'})` : ''
      }; returned: ${truncate(result.text)}`,
      { retryable: true, usage },
    );
  }

  return {
    value: parsed.data,
    usage,
    method: 'prompted',
    raw: result.text,
    repairs: repaired.repairs,
  };
}

/**
 * The schema, as prose the model can follow.
 *
 * `io: 'input'` for the same reason the budget meter uses it — this must
 * describe what the model should *produce*, which for a codec is the wire shape
 * and not the domain one.
 *
 * Examples are included when the caller supplied them. This is the only method
 * that reads them, because it is the only one with no structural guarantee: a
 * worked example is doing the job a grammar would otherwise do, and paying
 * tokens for one under a decoder would be spending to restate a certainty.
 */
function renderContract<T>(elicitation: Elicitation<T>): string {
  const schema = JSON.stringify(
    z.toJSONSchema(elicitation.schema as z.ZodType<unknown>, { io: 'input' }),
  );

  const examples = (elicitation.examples ?? []).map(
    (example, index) => `Example ${index + 1}:\n${JSON.stringify(example, null, 2)}`,
  );

  return [
    'Reply with a single JSON value and nothing else — no prose, no code fence,',
    'no explanation. It must satisfy this JSON Schema exactly:',
    '',
    schema,
    ...(examples.length === 0 ? [] : ['', 'Shaped like these:', '', ...examples]),
  ].join('\n');
}

function usageOf<T>(
  config: VercelAdapterConfig,
  elicitation: Elicitation<T>,
  usage: { inputTokens?: number | undefined; outputTokens?: number | undefined },
): Usage {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return Usage.parse({
    operation: elicitation.operation,
    provider: config.provider,
    model: config.modelId,
    inputTokens,
    outputTokens,
    // null for a model the price table does not know — `sumUsage`
    // distinguishes that from a genuine zero, so an unpriced model
    // reads "cost unknown" rather than confidently reading "free".
    costMinorUnits: costMinorUnitsFor(config.modelId, inputTokens, outputTokens),
  });
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
  request: Elicitation<unknown>,
  modelId: string,
): CapabilityError {
  // Already ours — the prompted path throws its own, correctly marked
  // retryable. Re-wrapping it here silently downgraded it to non-retryable, so
  // a recoverable prompted failure was never retried. Caught by a test; the
  // catch that exists to stop vendor errors escaping was eating our own.
  if (error instanceof CapabilityError) return error;

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
  request: Elicitation<unknown>,
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
