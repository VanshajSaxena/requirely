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
 * Two Anthropic limits collide with structured output, and the collision used to
 * decide how every request was sent. Both were found by live calls that failed
 * and therefore cost nothing.
 *
 * **1. Constrained decoding caps optional properties at 24.** Anthropic compiles
 * the JSON Schema into a decoding grammar and refuses one this branchy:
 *
 * > Schemas contains too many optional parameters (71), which would make grammar
 * > compilation inefficient. […] (limit: 24).
 *
 * **2. Forced tool use forbids thinking.** The escape from (1) is `jsonTool`
 * mode — the schema goes as an ordinary non-strict tool, no grammar, no limit —
 * but it forces `tool_choice`, and then:
 *
 * > Thinking may not be enabled when tool_choice forces tool use.
 *
 * ## What changed, and why this code stayed
 *
 * The fix is not here. `src/wire/` now sits between the domain and every model:
 * a flat, sentinel-encoded op list that measures **0 optional / 0 union / 1.9 KB**
 * where the domain delta measures 84 / 34 / 9.9 KB. Every operation is now well
 * inside both caps:
 *
 * | Schema | optional | union |
 * | --- | ---: | ---: |
 * | `analyze` (wire codec) | 0 | 0 |
 * | `analyze-and-assess` | 1 | 0 |
 * | `assess` | 1 | 0 |
 * | `generate-questions` | 5 | 3 |
 *
 * **So `jsonTool` no longer fires, and the thing it cost has come back.** The
 * previous version of this comment recorded the honest damage: *"this disables
 * thinking on `analyze`, which is the call that wanted it most"* — `EFFORT.analyze`
 * is `high` precisely because contradiction detection across sources is the
 * hardest thing the engine asks for. That is repaired, and it was repaired by
 * changing what the model is *asked for* rather than by weakening the domain.
 *
 * The check below stays anyway, as a graceful degradation rather than a
 * workaround. A future field could push `generate-questions` over the line, and
 * the difference between "the mode switches and thinking turns off" and "the
 * request 400s" is the difference between a slower turn and a lost one.
 * `src/wire/codec.test.ts` asserts the cap at CI time, so this should now be
 * unreachable — if it ever fires in production, that test has a gap.
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
