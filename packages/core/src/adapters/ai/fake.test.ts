import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CapabilityError, OPERATION } from '../../domain/index.ts';
import { fakeStructuredGenerator } from './fake.ts';

const Shape = z.object({ value: z.string().min(1) });
const request = (input = 'hello') => ({
  operation: OPERATION.assess,
  instructions: 'be useful',
  input,
});

describe('fakeStructuredGenerator', () => {
  it('returns scripted responses in order, per operation', async () => {
    const fake = fakeStructuredGenerator({
      assess: [{ value: 'first' }, { value: 'second' }],
    });

    expect((await fake.generate(Shape, request())).value).toEqual({ value: 'first' });
    expect((await fake.generate(Shape, request())).value).toEqual({ value: 'second' });
  });

  it('validates scripted responses against the schema, exactly as a real model is validated', async () => {
    const fake = fakeStructuredGenerator({ assess: [{ value: '' }] });

    // A fixture that drifts from the domain must fail here. A fake that skips
    // this only ever tests itself.
    await expect(fake.generate(Shape, request())).rejects.toThrow(CapabilityError);
  });

  it('fails clearly when a script runs dry rather than returning undefined', async () => {
    const fake = fakeStructuredGenerator({ assess: [] });
    await expect(fake.generate(Shape, request())).rejects.toThrow(/no scripted response left/);
  });

  it('estimates usage proportional to payload, so token comparisons are meaningful', async () => {
    const fake = fakeStructuredGenerator({ assess: [{ value: 'x' }, { value: 'x' }] });

    const small = await fake.generate(Shape, request('short'));
    const large = await fake.generate(Shape, request('a'.repeat(4000)));

    expect(large.usage.inputTokens).toBeGreaterThan(small.usage.inputTokens * 10);
    expect(small.usage.operation).toBe('assess');
  });

  it('records calls for inspection and reports an undrained script', async () => {
    const fake = fakeStructuredGenerator({ assess: [{ value: 'a' }, { value: 'b' }] });
    await fake.generate(Shape, request());

    expect(fake.callsFor(OPERATION.assess)).toHaveLength(1);
    expect(fake.callsFor(OPERATION.analyze)).toHaveLength(0);
    expect(() => fake.assertScriptDrained()).toThrow(/assess: 1 unused/);
  });
});
