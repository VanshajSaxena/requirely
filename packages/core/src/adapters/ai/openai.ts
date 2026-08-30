import { createOpenAI } from '@ai-sdk/openai';
import type { StructuredGenerator } from '../../domain/index.ts';
import { vercelStructuredGenerator } from './vercel.ts';

/**
 * OpenAI, via the AI SDK.
 *
 * The second real adapter exists to keep the first one honest. One provider
 * always leaks its assumptions unnoticed — you cannot tell a port from a
 * pass-through until something else has to fit through it.
 *
 * It kept that job even as both adapters shrank to this. `effort` now reaches
 * every vendor through one spec-level `reasoning` option, and this provider
 * resolves it differently from Anthropic's: it falls back to `reasoning` only
 * when `providerOptions.openai.reasoningEffort` is unset, and only sends it at
 * all for models it classifies as reasoning models. Same domain concept, two
 * unrelated resolutions — which is still the evidence, just observed one layer
 * further down than Phase 4 looked.
 */

export interface OpenAIConfig {
  readonly apiKey: string;
  readonly model: string;
}

export function openaiStructuredGenerator(config: OpenAIConfig): StructuredGenerator {
  const openai = createOpenAI({ apiKey: config.apiKey });

  return vercelStructuredGenerator({
    provider: 'openai',
    model: openai(config.model),
    modelId: config.model,
  });
}
