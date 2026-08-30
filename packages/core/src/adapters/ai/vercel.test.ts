import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CapabilityError, OPERATION } from '../../domain/index.ts';
import { reasoningFor, vercelStructuredGenerator } from './vercel.ts';

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

const generatorOver = (model: MockLanguageModelV4, modelId = 'mock-1') =>
  vercelStructuredGenerator({ provider: 'test', model, modelId });

describe('effort — one vendor-neutral setting, resolved per model', () => {
  it('sends `effort` to the provider as the spec-level `reasoning` option', async () => {
    // Asserted through the real request path rather than by checking a mapper's
    // return value. That distinction is the whole reason this file changed: the
    // old tests asserted a hand-written table back to itself and passed while
    // the table sent a parameter `claude-opus-5` rejects with a 400.
    const model = modelReturning('{"value":"ok"}');
    await generatorOver(model).generate(Shape, { ...request, effort: 'high' });

    expect(model.doGenerateCalls[0]?.reasoning).toBe('high');
  });

  it('defaults to medium when the engine expresses no preference', async () => {
    const model = modelReturning('{"value":"ok"}');
    await generatorOver(model).generate(Shape, request);

    expect(model.doGenerateCalls[0]?.reasoning).toBe('medium');
    expect(reasoningFor(undefined)).toBe(reasoningFor('medium'));
  });

  it('maps every Effort the domain can produce', () => {
    // Exhaustive by construction: `REASONING` is a Record over `Effort`, so
    // adding a level to the domain fails to compile until it is mapped here.
    expect([reasoningFor('low'), reasoningFor('medium'), reasoningFor('high')]).toEqual([
      'low',
      'medium',
      'high',
    ]);
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
      // `mock-1` is not in the price table, so null rather than 0 — `sumUsage`
      // keeps "not reported" apart from "free". The priced path is asserted
      // below, and the arithmetic in pricing.test.ts.
      costMinorUnits: null,
    });
  });

  it('prices the call when the model id is known, so cost is stored and not merely printed', async () => {
    const result = await generatorOver(
      modelReturning('{"value":"ok"}'),
      'claude-haiku-4-5',
    ).generate(Shape, request);

    // 120 input @ 100 minor/MTok + 34 output @ 500 minor/MTok. Fractional cents
    // on purpose: rounding each call up to a whole cent would report a cheap
    // session at many times its real price.
    expect(result.usage.costMinorUnits).toBeCloseTo(0.029, 6);
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
