import { createAnthropic } from '@ai-sdk/anthropic';
import type { GenerationMethod, StructuredGenerator } from '../../domain/index.ts';
import type { CallObserver } from '../../observability/calls.ts';
import type { Logger } from '../../observability/logger.ts';
import { type GrammarCaps, methodFor } from './method.ts';
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

/**
 * What Anthropic will compile, and what its escape hatch costs.
 *
 * `toolModeForbidsThinking` is the entry that makes this more than a size limit.
 * `jsonTool` forces `tool_choice`, and forced tool use rejects extended thinking
 * outright — so for a high-effort operation, dropping to `tool` trades away the
 * deliberation that made it high-effort in the first place. `chooseMethod` reads
 * that and prefers `prompted` in exactly that case.
 */
export const ANTHROPIC_CAPS: GrammarCaps = {
  supportsConstrained: true,
  optional: 24,
  union: 16,
  toolModeForbidsThinking: true,
};

/** Vendor spelling for a chosen method. Mechanical once the choice is made. */
const OPTIONS_FOR: Record<GenerationMethod, Record<string, Record<string, unknown>> | undefined> = {
  constrained: { anthropic: { structuredOutputMode: 'outputFormat' } },
  // Thinking must be disabled explicitly, not merely left unset: provider
  // options take precedence over the `reasoning` setting in the SDK, and some
  // models default thinking on — which this mode rejects.
  tool: { anthropic: { structuredOutputMode: 'jsonTool', thinking: { type: 'disabled' } } },
  // No structured-output feature involved at all; `generateText` is the call.
  prompted: undefined,
};

export interface AnthropicConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly logger?: Logger | undefined;
  readonly observer?: CallObserver | undefined;
}

export function anthropicStructuredGenerator(config: AnthropicConfig): StructuredGenerator {
  const anthropic = createAnthropic({ apiKey: config.apiKey });

  return vercelStructuredGenerator({
    provider: 'anthropic',
    model: anthropic(config.model),
    modelId: config.model,
    ...(config.logger === undefined ? {} : { logger: config.logger }),
    ...(config.observer === undefined ? {} : { observer: config.observer }),
    methodFor: (schema, effort) => methodFor(schema, ANTHROPIC_CAPS, effort === 'high'),
    optionsFor: (method) => OPTIONS_FOR[method],
  });
}
