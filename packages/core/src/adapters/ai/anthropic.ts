import { createAnthropic } from '@ai-sdk/anthropic';
import type { Effort, StructuredGenerator } from '../../domain/index.ts';
import { type EffortMapper, vercelStructuredGenerator } from './vercel.ts';

/**
 * Anthropic, via the AI SDK.
 *
 * `effort` becomes an extended-thinking budget. The mapping is a judgement, not
 * a formula: `low` disables thinking entirely because question wording does not
 * need deliberation, while `high` buys real budget because detecting a
 * contradiction across sources is the hardest thing the engine asks for.
 *
 * That this mapping is *possible* — and different from OpenAI's — is what makes
 * `effort` a capability knob rather than a vendor leak. If it had turned out to
 * be a pass-through of one vendor's parameter, the abstraction would have been
 * a lie and this is where it would have shown.
 */

const THINKING_BUDGET: Record<Effort, number> = {
  low: 0,
  medium: 4_000,
  high: 12_000,
};

export interface AnthropicConfig {
  readonly apiKey: string;
  readonly model: string;
}

/** Exported so the mapping is assertable without a network call or a mock model. */
export const anthropicEffort: EffortMapper = (effort) => {
  const budget = THINKING_BUDGET[effort ?? 'medium'];
  if (budget === 0) return {};
  return { anthropic: { thinking: { type: 'enabled', budgetTokens: budget } } };
};

export function anthropicStructuredGenerator(config: AnthropicConfig): StructuredGenerator {
  const anthropic = createAnthropic({ apiKey: config.apiKey });

  return vercelStructuredGenerator({
    provider: 'anthropic',
    model: anthropic(config.model),
    modelId: config.model,
    mapEffort: anthropicEffort,
  });
}
