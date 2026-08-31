import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CapabilityError, type GenerationMethod, OPERATION } from '../../domain/index.ts';
import type { MethodChoice } from './method.ts';
import { reasoningFor, vercelStructuredGenerator } from './vercel.ts';

/**
 * The provider adapters, without a key or a network call.
 *
 * These are the tests the recording adapter cannot give: a replay returns a
 * stored value and never exercises request-building, usage mapping, or error
 * translation. This file covers exactly that gap.
 */

const Shape = z.object({ value: z.string() });
const request = {
  operation: OPERATION.assess,
  instructions: 'be useful',
  input: 'hello',
  schema: Shape,
};

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

/** An adapter pinned to one method, so a path can be exercised without a real cap table. */
const asMethod = (model: MockLanguageModelV4, method: GenerationMethod) =>
  vercelStructuredGenerator({
    provider: 'test',
    model,
    modelId: 'mock-1',
    methodFor: (): MethodChoice => ({
      method,
      reason: 'pinned by a test',
      budget: { optional: 0, union: 0, bytes: 0 },
    }),
    optionsFor: (chosen) => (chosen === 'prompted' ? undefined : { test: { mode: chosen } }),
  });

describe('effort — one vendor-neutral setting, resolved per model', () => {
  it('sends `effort` to the provider as the spec-level `reasoning` option', async () => {
    // Asserted through the real request path rather than by checking a mapper's
    // return value. That distinction is the whole reason this file changed: the
    // old tests asserted a hand-written table back to itself and passed while
    // the table sent a parameter `claude-opus-5` rejects with a 400.
    const model = modelReturning('{"value":"ok"}');
    await generatorOver(model).generate({ ...request, effort: 'high' });

    expect(model.doGenerateCalls[0]?.reasoning).toBe('high');
  });

  it('defaults to medium when the engine expresses no preference', async () => {
    const model = modelReturning('{"value":"ok"}');
    await generatorOver(model).generate(request);

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
    const result = await generatorOver(modelReturning('{"value":"ok"}')).generate(request);

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
    ).generate(request);

    // 120 input @ 100 minor/MTok + 34 output @ 500 minor/MTok. Fractional cents
    // on purpose: rounding each call up to a whole cent would report a cheap
    // session at many times its real price.
    expect(result.usage.costMinorUnits).toBeCloseTo(0.029, 6);
  });

  it('sends instructions as system and input as prompt, so a stable prefix stays cacheable', async () => {
    const model = modelReturning('{"value":"ok"}');
    await generatorOver(model).generate(request);

    const sent = JSON.stringify(model.doGenerateCalls[0]);
    expect(sent).toContain('be useful');
    expect(sent).toContain('hello');
  });

  it('translates a schema disagreement into a retryable CapabilityError', async () => {
    // Valid JSON, wrong shape — what `withValidationRetry` is built to recover from.
    const generator = generatorOver(modelReturning('{"wrong":"shape"}'));

    await expect(generator.generate(request)).rejects.toMatchObject({
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
      .generate(request)
      .catch((e: unknown) => e);

    // No vendor error type escapes the adapter, and a 401 must never be retried.
    expect(error).toBeInstanceOf(CapabilityError);
    expect((error as CapabilityError).retryable).toBe(false);
    expect((error as CapabilityError).message).toContain('401');
  });
});

describe('three methods behind one port', () => {
  it('reports the method it used, and reports no repairs on a clean call', async () => {
    const result = await generatorOver(modelReturning('{"value":"ok"}')).generate(request);

    expect(result.method).toBe('constrained');
    expect(result.repairs).toEqual([]);
    // `null`, not the object re-serialized. The object path has no raw text, and
    // inventing one would be a lie exactly where a reader would trust it.
    expect(result.raw).toBeNull();
  });

  it('sends the vendor option the chosen method implies', async () => {
    const model = modelReturning('{"value":"ok"}');
    await asMethod(model, 'tool').generate(request);

    expect(JSON.stringify(model.doGenerateCalls[0])).toContain('"mode":"tool"');
  });

  it('falls all the way back to prose when the provider can constrain nothing', async () => {
    // The floor of the ladder, and the reason `StructuredGenerator` is a port
    // rather than a shared spelling for two vendors that already agree.
    const model = modelReturning('{"value":"ok"}');
    const result = await asMethod(model, 'prompted').generate(request);

    expect(result.value).toEqual({ value: 'ok' });
    expect(result.method).toBe('prompted');
    // Raw text survives here, because here there is some.
    expect(result.raw).toBe('{"value":"ok"}');
  });

  it('puts the schema in the prompt when nothing else will carry it', async () => {
    const model = modelReturning('{"value":"ok"}');
    await asMethod(model, 'prompted').generate(request);

    const sent = JSON.stringify(model.doGenerateCalls[0]);
    expect(sent).toContain('JSON Schema');
    // The role-defining prefix stays first, so a provider caching on it still can.
    expect(sent).toContain('be useful');
    // And no tool/response-format machinery is involved at all.
    expect(sent).not.toContain('mode');
  });

  it('includes examples only on the method with no structural guarantee', async () => {
    const withExamples = { ...request, examples: [{ value: 'like this' }] };

    const prompted = modelReturning('{"value":"ok"}');
    await asMethod(prompted, 'prompted').generate(withExamples);
    expect(JSON.stringify(prompted.doGenerateCalls[0])).toContain('like this');

    // Paying tokens for an example a decoder already enforces is spending to
    // restate a certainty.
    const constrained = modelReturning('{"value":"ok"}');
    await asMethod(constrained, 'constrained').generate(withExamples);
    expect(JSON.stringify(constrained.doGenerateCalls[0])).not.toContain('like this');
  });

  it('repairs prose around the answer and says what it repaired', async () => {
    const model = modelReturning('Sure — here you go:\n```json\n{"value":"ok",}\n```');
    const result = await asMethod(model, 'prompted').generate(request);

    expect(result.value).toEqual({ value: 'ok' });
    expect(result.repairs).toEqual([
      'extracted the JSON value from surrounding text',
      'removed trailing commas',
    ]);
  });

  it('makes a prompted schema failure retryable and bills for it', async () => {
    // Same contract as the object path: a schema disagreement is recoverable,
    // and the provider charged for the attempt either way.
    const model = modelReturning('{"wrong":"shape"}');
    const error = await asMethod(model, 'prompted')
      .generate(request)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CapabilityError);
    expect(error).toMatchObject({ retryable: true });
    expect((error as CapabilityError).usage).toMatchObject({ inputTokens: 120 });
  });

  it('fails rather than guessing when the reply contains no JSON at all', async () => {
    const model = modelReturning('I am not able to help with that.');
    await expect(asMethod(model, 'prompted').generate(request)).rejects.toThrow(CapabilityError);
  });
});
