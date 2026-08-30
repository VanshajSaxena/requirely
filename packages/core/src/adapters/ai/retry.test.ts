import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CapabilityError, OPERATION } from '../../domain/index.ts';
import { recordingLogger } from '../../observability/logger.ts';
import { fakeStructuredGenerator } from './fake.ts';
import { withValidationRetry } from './retry.ts';

/**
 * The retry decorator, tested entirely against the fake.
 *
 * That is the payoff of making it a decorator rather than logic inside each
 * provider adapter: recovery behaviour is verified with no key, no network and
 * no spend, and it applies to every provider present and future.
 */

const Shape = z.object({ value: z.string().min(1) });
const request = { operation: OPERATION.assess, instructions: 'be useful', input: 'hello' };

describe('the cost of a retry', () => {
  it('reports the wasted attempt as well as the successful one', async () => {
    // Before this, a recovered call reported only its final attempt: the failed
    // one threw, and its usage died with the exception. Every retried turn
    // therefore under-reported what it actually cost — invisible, because the
    // number it printed was plausible.
    const generator = withValidationRetry(
      fakeStructuredGenerator({ assess: [{ wrong: 'shape' }, { value: 'ok' }] }),
    );

    const recovered = await generator.generate(Shape, request);
    const direct = await withValidationRetry(
      fakeStructuredGenerator({ assess: [{ value: 'ok' }] }),
    ).generate(Shape, request);

    expect(recovered.value).toEqual({ value: 'ok' });
    // Strictly more than the same call made without a retry — the difference is
    // exactly the attempt that was thrown away.
    expect(recovered.usage.outputTokens).toBeGreaterThan(direct.usage.outputTokens);
    expect(recovered.usage.inputTokens).toBeGreaterThan(direct.usage.inputTokens);
  });
});

describe('withValidationRetry', () => {
  it('recovers when a later attempt satisfies the schema', async () => {
    // `{ value: '' }` fails `min(1)`; the fake reports it as retryable exactly
    // as a real provider does.
    const fake = fakeStructuredGenerator({ assess: [{ value: '' }, { value: 'corrected' }] });
    const generator = withValidationRetry(fake, { maxAttempts: 3 });

    expect((await generator.generate(Shape, request)).value).toEqual({ value: 'corrected' });
    expect(fake.calls).toHaveLength(2);
  });

  it('shows the model what was wrong instead of just asking again', async () => {
    const fake = fakeStructuredGenerator({ assess: [{ value: '' }, { value: 'ok' }] });
    await withValidationRetry(fake, { maxAttempts: 2 }).generate(Shape, request);

    const second = fake.calls[1];
    expect(second?.input).toContain('did not satisfy the required schema');
    // The original input must survive — the correction is an addition, not a
    // replacement, or the model loses the thing it was asked to do.
    expect(second?.input).toContain('hello');
  });

  it('gives up after the configured number of attempts', async () => {
    const fake = fakeStructuredGenerator({ assess: [{ value: '' }, { value: '' }] });
    const generator = withValidationRetry(fake, { maxAttempts: 2 });

    await expect(generator.generate(Shape, request)).rejects.toThrow(CapabilityError);
    expect(fake.calls).toHaveLength(2);
  });

  it('does not retry a failure that repeating cannot fix', async () => {
    // An empty script is a "no scripted response" CapabilityError with
    // `retryable: false` — the stand-in for a 401 or a missing key. Retrying
    // that only spends the user's money more slowly.
    const fake = fakeStructuredGenerator({ assess: [] });
    const generator = withValidationRetry(fake, { maxAttempts: 3 });

    await expect(generator.generate(Shape, request)).rejects.toThrow(/no scripted response/);
    expect(fake.calls).toHaveLength(1);
  });

  it('logs every failed attempt, which is how retry frequency becomes measurable', async () => {
    const logger = recordingLogger();
    const fake = fakeStructuredGenerator({ assess: [{ value: '' }, { value: 'ok' }] });

    await withValidationRetry(fake, { maxAttempts: 3, logger }).generate(Shape, request);

    const warnings = logger.entries.filter((entry) => entry.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toMatchObject({ operation: 'assess', attempt: 1 });
    expect(logger.entries.some((e) => e.message.includes('recovered'))).toBe(true);
  });

  it('leaves a first-attempt success untouched', async () => {
    const logger = recordingLogger();
    const fake = fakeStructuredGenerator({ assess: [{ value: 'fine' }] });

    await withValidationRetry(fake, { logger }).generate(Shape, request);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.input).toBe('hello');
    expect(logger.entries).toEqual([]);
  });
});
