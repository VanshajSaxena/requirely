import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CapabilityError, OPERATION } from '../../domain/index.ts';
import { anthropicEffort } from './anthropic.ts';
import { openaiEffort } from './openai.ts';
import { vercelStructuredGenerator } from './vercel.ts';

/**
 * The provider adapters, without a key or a network call.
 *
 * These are the tests the recording adapter cannot give: a replay returns a
 * stored value and never exercises request-building, usage mapping, or error
 * translation. This file covers exactly that gap.
 */

const Shape = z.object({ value: z.string() });
const request = { operation: OPERATION.assess, instructions: 'be useful', input: 'hello' };

/**
 * `MockDoGenerate` is the SDK's own parameter type. Building the literal inline
 * fails to match `LanguageModelV4GenerateResult` exactly — the provider spec's
 * content-part union carries fields this fixture does not need — so the shape is
 * asserted once here rather than chased through a third-party type. What the
 * fixture actually claims is verified by the assertions below.
 */
type MockDoGenerate = NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>;

const modelReturning = (text: string) =>
  new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-1',
    doGenerate: (async () => ({
      content: [{ type: 'text' as const, text }],
      finishReason: 'stop' as const,
      // V4's provider-level usage nests token counts with a cache breakdown;
      // the SDK flattens it before `generateObject` returns, which is the shape
      // the adapter reads.
      usage: {
        inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 34, text: 34, reasoning: 0 },
      },
      warnings: [],
    })) as unknown as NonNullable<MockDoGenerate['doGenerate']>,
  });

const generatorOver = (model: MockLanguageModelV4) =>
  vercelStructuredGenerator({
    provider: 'test',
    model,
    modelId: 'mock-1',
    mapEffort: () => ({}),
  });

describe('effort mapping — the test of whether `effort` was a domain concept', () => {
  it('Anthropic spends it as an extended-thinking budget', () => {
    // `low` disables thinking outright: rewording a question needs no deliberation.
    expect(anthropicEffort('low')).toEqual({});
    expect(anthropicEffort('high')).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 12_000 } },
    });
  });

  it('OpenAI spends it as a named reasoning level', () => {
    expect(openaiEffort('high')).toEqual({ openai: { reasoningEffort: 'high' } });
    expect(openaiEffort('low')).toEqual({ openai: { reasoningEffort: 'low' } });
  });

  it('two vendors, two spellings, neither reaching the engine', () => {
    // If `effort` had been one vendor's parameter wearing a generic name, these
    // two would look alike. They do not — which is the evidence the port held.
    expect(Object.keys(anthropicEffort('high'))).toEqual(['anthropic']);
    expect(Object.keys(openaiEffort('high'))).toEqual(['openai']);
  });

  it('defaults to medium when the engine expresses no preference', () => {
    expect(anthropicEffort(undefined)).toEqual(anthropicEffort('medium'));
    expect(openaiEffort(undefined)).toEqual(openaiEffort('medium'));
  });
});

describe('vercelStructuredGenerator', () => {
  it('returns the parsed object with usage tagged by operation and provider', async () => {
    const result = await generatorOver(modelReturning('{"value":"ok"}')).generate(Shape, request);

    expect(result.value).toEqual({ value: 'ok' });
    expect(result.usage).toMatchObject({
      operation: 'assess',
      provider: 'test',
      model: 'mock-1',
      inputTokens: 120,
      outputTokens: 34,
      // Null rather than 0: there is no price table yet, and `sumUsage`
      // distinguishes "not reported" from "free".
      costMinorUnits: null,
    });
  });

  it('sends instructions as system and input as prompt, so a stable prefix stays cacheable', async () => {
    const model = modelReturning('{"value":"ok"}');
    await generatorOver(model).generate(Shape, request);

    const sent = JSON.stringify(model.doGenerateCalls[0]);
    expect(sent).toContain('be useful');
    expect(sent).toContain('hello');
  });

  it('translates a schema disagreement into a retryable CapabilityError', async () => {
    // Valid JSON, wrong shape — what `withValidationRetry` is built to recover from.
    const generator = generatorOver(modelReturning('{"wrong":"shape"}'));

    await expect(generator.generate(Shape, request)).rejects.toMatchObject({
      name: 'CapabilityError',
      retryable: true,
    });
  });

  it('translates other vendor failures into a non-retryable CapabilityError', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: (async () => {
        throw new Error('401 invalid api key');
      }) as unknown as NonNullable<MockDoGenerate['doGenerate']>,
    });

    const error = await generatorOver(model)
      .generate(Shape, request)
      .catch((e: unknown) => e);

    // No vendor error type escapes the adapter, and a 401 must never be retried.
    expect(error).toBeInstanceOf(CapabilityError);
    expect((error as CapabilityError).retryable).toBe(false);
    expect((error as CapabilityError).message).toContain('401');
  });
});
