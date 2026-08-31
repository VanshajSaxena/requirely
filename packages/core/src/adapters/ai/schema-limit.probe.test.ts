import { join } from 'node:path';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateObject, jsonSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadEnvFile } from '../../config/env.ts';
import { UnderstandingDelta } from '../../domain/index.ts';

/**
 * A probe, not a test of our code: **does required-and-nullable escape
 * Anthropic's optional-property limit?**
 *
 * Constrained decoding rejects `UnderstandingDelta` for having 71 optional
 * properties against a limit of 24. 51 of those 71 are optional only because a
 * Zod `.default()` renders as an absent-able property in the input schema — they
 * are two-state (a value, or null) wearing a three-state shape. Only 20 are
 * genuinely three-state, which is the `revise` contract: absent means unchanged,
 * null means cleared.
 *
 * If required-and-nullable does not count as optional, then 71 -> 20 is a
 * *representation* change and the domain's semantics survive untouched. That is
 * a very different conclusion from "the delta shape is incompatible", so it is
 * worth one cent to find out rather than reasoning about it.
 *
 * Gated behind `REQUIRELY_LIVE=1`: it makes real calls. A rejected schema is a
 * 400 and costs nothing; an accepted one costs a fraction of a cent.
 */

const LIVE = process.env.REQUIRELY_LIVE === '1';
const MODEL = process.env.REQUIRELY_LIVE_MODEL ?? 'claude-haiku-4-5';

type Node = Record<string, unknown>;

/** Every optional property, by path — the same count Anthropic reports. */
function countOptional(root: unknown): number {
  let n = 0;
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const rec = node as Node;
    const props = rec['properties'];
    if (rec['type'] === 'object' && props !== null && typeof props === 'object') {
      const required = new Set(Array.isArray(rec['required']) ? rec['required'] : []);
      n += Object.keys(props as Node).filter((k) => !required.has(k)).length;
    }
    for (const v of Object.values(rec)) walk(v);
  };
  walk(root);
  return n;
}

/**
 * Marks every property required, allowing `null` where it was optional.
 *
 * `keepOptionalUnder` opts a subtree out — used to leave `revise` genuinely
 * three-state, which is the shape the real fix would keep.
 */
function requireAll(node: unknown, path = '', keepOptionalUnder?: RegExp): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => requireAll(n, path, keepOptionalUnder));

  const rec = { ...(node as Node) };
  for (const [key, value] of Object.entries(rec)) {
    if (key === 'properties' && value !== null && typeof value === 'object') {
      const props = value as Node;
      rec['properties'] = Object.fromEntries(
        Object.entries(props).map(([k, v]) => [
          k,
          requireAll(v, `${path}.${k}`, keepOptionalUnder),
        ]),
      );
    } else {
      rec[key] = requireAll(value, path, keepOptionalUnder);
    }
  }

  const props = rec['properties'];
  const exempt = keepOptionalUnder?.test(path) ?? false;
  if (rec['type'] === 'object' && props !== null && typeof props === 'object' && !exempt) {
    const keys = Object.keys(props as Node);
    const alreadyRequired = new Set(Array.isArray(rec['required']) ? rec['required'] : []);
    rec['required'] = keys;
    // A property that used to be absent-able must now be expressible as null.
    rec['properties'] = Object.fromEntries(
      Object.entries(props as Node).map(([k, v]) => [
        k,
        alreadyRequired.has(k) ? v : { anyOf: [v, { type: 'null' }] },
      ]),
    );
  }
  return rec;
}

describe.skipIf(!LIVE)('Anthropic constrained decoding — what actually counts as optional', () => {
  const base = z.toJSONSchema(UnderstandingDelta, { io: 'input' });

  async function accepts(schema: unknown): Promise<{ ok: boolean; error: string }> {
    loadEnvFile(join(import.meta.dirname, '../../../../../.env'));
    const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
    try {
      await generateObject({
        model: anthropic(MODEL),
        schema: jsonSchema(schema as never),
        system: 'Return an empty delta.',
        prompt: 'Nothing changed.',
        maxOutputTokens: 1_000,
        providerOptions: { anthropic: { structuredOutputMode: 'outputFormat' } } as never,
      });
      return { ok: true, error: '' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  it('rejects the schema as it stands today', async () => {
    expect(countOptional(base)).toBe(71);
    const result = await accepts(base);
    console.info(`[probe] as-is (71 optional): ${result.ok ? 'ACCEPTED' : result.error}`);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('optional');
  }, 120_000);

  it('accepts it when every property is required — required+nullable is not optional', async () => {
    const allRequired = requireAll(base);
    expect(countOptional(allRequired)).toBe(0);

    const result = await accepts(allRequired);
    console.info(`[probe] all required (0 optional): ${result.ok ? 'ACCEPTED' : result.error}`);
    expect(result.ok, result.error).toBe(true);
  }, 120_000);

  it('accepts it with only `revise` left genuinely three-state', async () => {
    // The shape the real fix would have: partial-update semantics preserved
    // exactly where the domain needs them, mechanical optionality removed
    // everywhere else.
    const reviseOnly = requireAll(base, '', /\.revise$/);
    const remaining = countOptional(reviseOnly);
    console.info(`[probe] revise-only optionality: ${remaining} optional properties`);
    expect(remaining).toBeLessThan(24);

    const result = await accepts(reviseOnly);
    console.info(
      `[probe] revise-only (${remaining} optional): ${result.ok ? 'ACCEPTED' : result.error}`,
    );
    expect(result.ok, result.error).toBe(true);
  }, 120_000);
});
