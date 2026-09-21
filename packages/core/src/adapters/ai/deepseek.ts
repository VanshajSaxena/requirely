import { createDeepSeek } from '@ai-sdk/deepseek';
import type { StructuredGenerator } from '../../domain/index.ts';
import type { CallObserver } from '../../observability/calls.ts';
import type { Logger } from '../../observability/logger.ts';
import { type GrammarCaps, methodFor } from './method.ts';
import { vercelStructuredGenerator } from './vercel.ts';

/**
 * DeepSeek, via the AI SDK.
 *
 * The cheapest credible option here, and a genuinely different lineage from the
 * other three — which is the real test of whether the port holds. OpenAI was
 * added in Phase 4 for exactly that reason and has paid off twice by resolving
 * `effort` differently from Anthropic.
 *
 * ## This adapter found a hole in `chooseMethod`
 *
 * DeepSeek is OpenAI-compatible and supports JSON **mode** — "return valid JSON"
 * — but not strict JSON **schema**. Before this file, `GrammarCaps` carried only
 * two numbers, and the budget check would have waved it straight through:
 * `analyze` measures **0 optional / 0 union** since the Phase 8 wire redesign, so
 * any cap at all is satisfied. The schema being good is what would have caused
 * the failure, which is the kind of bug worth naming.
 *
 * Hence `supportsConstrained: false`, and hence this adapter is the first thing
 * in the repo that exercises the ladder's *descent* rather than its table. Until
 * now `constrained → tool → prompted` has only been tested against a fixture of
 * caps — never against a provider that genuinely cannot take a schema.
 */

/**
 * No schema-constrained decoding; tool mode permits thinking.
 *
 * The two numbers are therefore unreachable — `chooseMethod` rejects
 * `constrained` before it reads them — and they are left at DeepSeek's documented
 * neighbourhood rather than zeroed, so that flipping `supportsConstrained` the
 * day DeepSeek ships strict schemas is a one-line change with the numbers already
 * beside it.
 */
export const DEEPSEEK_CAPS: GrammarCaps = {
  supportsConstrained: false,
  optional: 20,
  union: 12,
  toolModeForbidsThinking: false,
};

export interface DeepSeekConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly logger?: Logger | undefined;
  readonly observer?: CallObserver | undefined;
}

export function deepseekStructuredGenerator(config: DeepSeekConfig): StructuredGenerator {
  const deepseek = createDeepSeek({ apiKey: config.apiKey });

  return vercelStructuredGenerator({
    provider: 'deepseek',
    model: deepseek(config.model),
    modelId: config.model,
    ...(config.logger === undefined ? {} : { logger: config.logger }),
    ...(config.observer === undefined ? {} : { observer: config.observer }),
    methodFor: (schema, effort) => methodFor(schema, DEEPSEEK_CAPS, effort === 'high'),
    // Nothing vendor-specific to send. `constrained` is unreachable above, and
    // the other two need no provider option — which is what a port looks like
    // when it is working.
    optionsFor: () => undefined,
  });
}
