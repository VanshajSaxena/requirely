import { createOpenAI } from '@ai-sdk/openai';
import type { Effort, StructuredGenerator } from '../../domain/index.ts';
import { type EffortMapper, vercelStructuredGenerator } from './vercel.ts';

/**
 * OpenAI, via the AI SDK.
 *
 * The second real adapter exists to keep the first one honest. One provider
 * always leaks its assumptions unnoticed — you cannot tell a port from a
 * pass-through until something else has to fit through it.
 *
 * Note how differently `effort` lands: Anthropic takes a *token budget* for
 * extended thinking, OpenAI takes a named `reasoningEffort` level. Neither
 * spelling reached the engine, which is the evidence the domain concept was
 * real rather than one vendor's parameter wearing a generic name.
 */

const REASONING_EFFORT: Record<Effort, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

export interface OpenAIConfig {
  readonly apiKey: string;
  readonly model: string;
}

/** Exported so the mapping is assertable without a network call or a mock model. */
export const openaiEffort: EffortMapper = (effort) => ({
  openai: { reasoningEffort: REASONING_EFFORT[effort ?? 'medium'] },
});

export function openaiStructuredGenerator(config: OpenAIConfig): StructuredGenerator {
  const openai = createOpenAI({ apiKey: config.apiKey });

  return vercelStructuredGenerator({
    provider: 'openai',
    model: openai(config.model),
    modelId: config.model,
    mapEffort: openaiEffort,
  });
}
