import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OPERATION } from '../../domain/index.ts';
import { fakeStructuredGenerator } from './fake.ts';
import { createCallMeter, withMetering } from './metering.ts';
import { withValidationRetry } from './retry.ts';

const Shape = z.object({ value: z.string().min(1) });
const request = {
  operation: OPERATION.assess,
  instructions: 'be useful',
  input: 'hi',
  schema: Shape,
};

describe('withMetering', () => {
  it('records the method and repair count a Turn cannot carry', async () => {
    const meter = createCallMeter();
    const generator = withMetering(
      fakeStructuredGenerator({ assess: [{ value: 'ok' }] }, { method: 'prompted' }),
      meter,
    );

    await generator.generate(request);

    expect(meter.calls).toHaveLength(1);
    expect(meter.calls[0]).toMatchObject({ operation: 'assess', method: 'prompted', repairs: [] });
    expect(meter.calls[0]?.usage.inputTokens).toBeGreaterThan(0);
  });

  it('counts one entry per logical call when wrapped outside the retry decorator', async () => {
    // Placement is the whole API. Outside retry, a recovered call is one entry
    // with the wasted attempts already folded into its usage by `withValidationRetry`.
    const meter = createCallMeter();
    const generator = withMetering(
      withValidationRetry(
        fakeStructuredGenerator({ assess: [{ value: '' }, { value: 'corrected' }] }),
      ),
      meter,
    );

    const result = await generator.generate(request);

    expect(result.value).toEqual({ value: 'corrected' });
    expect(meter.calls).toHaveLength(1);
  });

  it('counts one entry per attempt when wrapped inside it', async () => {
    // The other placement, for a debugging session that wants to see each try.
    const meter = createCallMeter();
    const generator = withValidationRetry(
      withMetering(
        fakeStructuredGenerator({ assess: [{ value: '' }, { value: 'corrected' }] }),
        meter,
      ),
    );

    await generator.generate(request);

    // Only the *successful* attempt is recorded: a failed one produced no method
    // and no repairs, and its tokens are already folded into the survivor.
    expect(meter.calls).toHaveLength(1);
  });

  it('does not record a call that failed outright', async () => {
    const meter = createCallMeter();
    const generator = withMetering(fakeStructuredGenerator({}), meter);

    await expect(generator.generate(request)).rejects.toThrow();
    expect(meter.calls).toEqual([]);
  });

  it('passes the result through untouched', async () => {
    // A decorator that changed what it observed would make every measurement a
    // measurement of the decorator.
    const meter = createCallMeter();
    const inner = fakeStructuredGenerator({ assess: [{ value: 'ok' }] });
    const direct = await inner.generate(request);

    const metered = await withMetering(
      fakeStructuredGenerator({ assess: [{ value: 'ok' }] }),
      meter,
    ).generate(request);

    expect(metered).toEqual(direct);
  });
});
