import { createOpenAI } from '@ai-sdk/openai';
import type { StructuredGenerator } from '../../domain/index.ts';
import { type GrammarCaps, methodFor } from './method.ts';
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
 *
 * It earns that job again here. OpenAI's structured outputs are **strictly less
 * expressive** than Anthropic's — [JSONSchemaBench] measured them compiling
 * 6–13% of hard real-world schemas against ~60% for the best open engine — and
 * OpenAI's own limits are stated as depth and property *counts* rather than as a
 * grammar-branchiness budget. So the caps below are not Anthropic's numbers with
 * a different label: they are deliberately conservative, and the honest position
 * is that they are unverified against a live call.
 *
 * The one thing that is certain: OpenAI does **not** forbid thinking in tool
 * mode, so unlike Anthropic there is no case where `prompted` beats `tool`.
 *
 * [JSONSchemaBench]: https://arxiv.org/html/2501.10868v3
 */

/**
 * Conservative, and **unverified against a live provider** — the org API spend
 * limit blocked the probe that would settle them. They are set below Anthropic's
 * because OpenAI's compiler is documented as accepting less, so an error here
 * degrades to `tool` early rather than 400ing late. Re-measure before trusting.
 */
const OPENAI_CAPS: GrammarCaps = {
  supportsConstrained: true,
  optional: 20,
  union: 12,
  toolModeForbidsThinking: false,
};

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
    methodFor: (schema, effort) => methodFor(schema, OPENAI_CAPS, effort === 'high'),
    optionsFor: (method) =>
      method === 'prompted'
        ? undefined
        : { openai: { structuredOutputs: method === 'constrained' } },
  });
}
