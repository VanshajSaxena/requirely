import { z } from 'zod';

/**
 * How much decoding-grammar budget a schema costs.
 *
 * Providers compile a strict JSON Schema into a grammar and cap its branchiness.
 * Two things drive the cost, and they trade against each other in a way that
 * makes the obvious fix the wrong one:
 *
 * - an **optional** property is a branch (present or not),
 * - a **union** — `anyOf`, `oneOf`, or a `type` array like `["string","null"]` —
 *   is a branch too, and providers cap unions *harder* than optionals.
 *
 * So making everything `required` and nullable moves spend from the looser
 * budget into the tighter one. `sentinel.ts` explains the encoding that avoids
 * both.
 *
 * **This lives in `wire/` rather than in an adapter because the caps are the
 * reason the wire layer exists.** The *numbers* are per-provider and stay in each
 * adapter; the measurement is a property of a JSON Schema and belongs where the
 * schema is designed. It was previously three separate copies of this walker —
 * one in `anthropic.ts`, one in a probe, one in a test — which is three chances
 * for the budget test and the runtime check to disagree about what they measure.
 */

export interface SchemaBudget {
  /** Properties absent from their object's `required` list. */
  readonly optional: number;
  /** Union-typed positions: `anyOf`, `oneOf`, or a `type` array. */
  readonly union: number;
  /** Serialized size, which is also what the request pays for in tokens. */
  readonly bytes: number;
}

/**
 * Measures the schema **as the model will see it**.
 *
 * `io: 'input'` by default and that default is load-bearing: it is the side
 * where a Zod `.default()` becomes an *optional* property, which is exactly what
 * a provider counts. Measuring `io: 'output'` would report a schema nobody
 * sends — and for a codec it would report the domain shape rather than the wire.
 */
export function measureBudget(
  schema: z.ZodType<unknown>,
  io: 'input' | 'output' = 'input',
): SchemaBudget {
  return measureJsonSchema(z.toJSONSchema(schema, { io }));
}

/**
 * The same measurement over an already-converted JSON Schema.
 *
 * Split out for the live probes, which hand-edit a converted schema to test a
 * provider's limits directly — they have a JSON Schema and no Zod schema to
 * derive it from. Sharing the walker is what keeps the probe measuring the same
 * thing the CI budget test and the runtime method choice measure.
 */
export function measureJsonSchema(json: unknown): SchemaBudget {
  let optional = 0;
  let union = 0;

  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;

    const properties = record.properties;
    if (record.type === 'object' && properties !== null && typeof properties === 'object') {
      const required = new Set(Array.isArray(record.required) ? record.required : []);
      optional += Object.keys(properties).filter((key) => !required.has(key)).length;
    }

    if (Array.isArray(record.anyOf) || Array.isArray(record.oneOf) || Array.isArray(record.type)) {
      union += 1;
    }

    for (const value of Object.values(record)) walk(value);
  };
  walk(json);

  return { optional, union, bytes: JSON.stringify(json).length };
}

/**
 * Measured once per schema and cached.
 *
 * Schemas are module constants, so the same object arrives on every call and
 * `z.toJSONSchema` on a delta is not cheap. A `WeakMap` keeps this from pinning
 * a schema that goes out of scope.
 */
const measured = new WeakMap<z.ZodType<unknown>, SchemaBudget>();

export function budgetOf(schema: z.ZodType<unknown>): SchemaBudget {
  const cached = measured.get(schema);
  if (cached !== undefined) return cached;
  const budget = measureBudget(schema);
  measured.set(schema, budget);
  return budget;
}
