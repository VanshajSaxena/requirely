import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import type { StructuredGenerator } from '../../domain/index.ts';
import { vercelStructuredGenerator } from './vercel.ts';

/**
 * Anthropic, via the AI SDK.
 *
 * Thin on purpose. This file used to carry an `effort` → extended-thinking-budget
 * table, and that table was wrong: it emitted `thinking: { type: 'enabled',
 * budgetTokens: N }`, which the Claude 5 family rejects with an HTTP 400, while
 * Haiku 4.5 requires exactly that form. Correctness depends on the *resolved
 * model*, which only the provider knows — so `effort` now travels as the SDK's
 * vendor-neutral `reasoning` setting and `@ai-sdk/anthropic` picks the spelling.
 * See the long note in `vercel.ts`.
 *
 * The lesson is more useful than the fix: nine tests covered that mapping and
 * every one of them passed, because a mapper can only be tested against the
 * shape you believed the vendor wanted. Asserting your own assumption back to
 * yourself is not evidence. That is why Phase 7 makes one real call before
 * building anything on top.
 */

/**
 * Two Anthropic limits collide with this domain, and the collision decides how
 * each request is sent. Both were found by live calls that failed and therefore
 * cost nothing.
 *
 * **1. Constrained decoding caps optional properties at 24.** Anthropic compiles
 * the JSON Schema into a decoding grammar, and refuses one this branchy:
 *
 * > Schemas contains too many optional parameters (71), which would make grammar
 * > compilation inefficient. […] (limit: 24).
 *
 * That is not schema sloppiness, which is why the fix lives here and not in the
 * domain. Counted on `UnderstandingDelta`: 6 optionals at the root (a delta
 * touching only requirements must omit the other five collections), 16 more for
 * each collection's `add`/`revise`/`remove`/`resolve`, and ~20 inside
 * `revise.items` — where **every field is optional by contract**, because
 * `patchOf()` exists precisely so that "unmentioned means unchanged". Reaching
 * 24 would mean deleting `revise`: an amputation of partial updates, not a
 * simplification.
 *
 * **2. Forced tool use forbids thinking.** The escape from (1) is `jsonTool`
 * mode, which sends the schema as an ordinary non-strict tool — no grammar, no
 * limit. But it also forces `tool_choice`, and then:
 *
 * > Thinking may not be enabled when tool_choice forces tool use.
 *
 * ## So the mode is chosen per request, not per provider
 *
 * | Schema | Optionals | Mode | Thinking |
 * | --- | --- | --- | --- |
 * | `analyze`, `analyze-and-assess` | 71, 72 | `jsonTool` | **off** |
 * | `assess`, `generate-questions` | 1, 4 | `outputFormat` | on, `effort` honoured |
 *
 * A uniform choice would have been simpler and strictly worse: sending
 * everything through `jsonTool` would disable thinking on the two calls where it
 * costs nothing to keep.
 *
 * **The honest part: this disables thinking on `analyze`, which is the call that
 * wanted it most** — `EFFORT.analyze` is `high` precisely because
 * contradiction-detection across sources is the hardest thing the engine asks
 * for. `effort` still reaches the vendor for the other two operations, so the
 * domain concept is not dead, but it is now unreachable exactly where it
 * mattered. Revisit if a future model raises the grammar limit above 71, or if
 * the delta shape ever shrinks.
 *
 * The trade also shifts schema conformance from the provider to us: `jsonTool`
 * output is not *guaranteed* to match. That is what `withValidationRetry` was
 * built for, and the live harness reports the retry rate, so the cost of this
 * decision is measured rather than assumed.
 */

/** Anthropic's documented ceiling for grammar-compiled schemas. */
const GRAMMAR_OPTIONAL_LIMIT = 24;

/**
 * Counted once per schema and cached: these are module constants, so the same
 * object arrives on every call and `z.toJSONSchema` on the delta is not cheap.
 */
const overLimit = new WeakMap<z.ZodType<unknown>, boolean>();

function exceedsGrammarLimit(schema: z.ZodType<unknown>): boolean {
  const cached = overLimit.get(schema);
  if (cached !== undefined) return cached;

  // `io: 'input'` is the shape the model must produce — the side where a Zod
  // `.default()` becomes an optional property, which is what Anthropic counts.
  let optional = 0;
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const properties = record['properties'];
    if (record['type'] === 'object' && properties !== null && typeof properties === 'object') {
      const required = new Set(Array.isArray(record['required']) ? record['required'] : []);
      optional += Object.keys(properties).filter((key) => !required.has(key)).length;
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(z.toJSONSchema(schema, { io: 'input' }));

  const result = optional > GRAMMAR_OPTIONAL_LIMIT;
  overLimit.set(schema, result);
  return result;
}

export interface AnthropicConfig {
  readonly apiKey: string;
  readonly model: string;
}

export function anthropicStructuredGenerator(config: AnthropicConfig): StructuredGenerator {
  const anthropic = createAnthropic({ apiKey: config.apiKey });

  return vercelStructuredGenerator({
    provider: 'anthropic',
    model: anthropic(config.model),
    modelId: config.model,
    providerOptionsFor: (schema) =>
      exceedsGrammarLimit(schema)
        ? // Thinking must be disabled explicitly, not merely left unset: provider
          // options take precedence over the `reasoning` setting in the SDK, and
          // some models default thinking on.
          { anthropic: { structuredOutputMode: 'jsonTool', thinking: { type: 'disabled' } } }
        : { anthropic: { structuredOutputMode: 'outputFormat' } },
  });
}
