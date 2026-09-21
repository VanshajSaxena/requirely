import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { StructuredGenerator } from '../../domain/index.ts';
import type { CallObserver } from '../../observability/calls.ts';
import type { Logger } from '../../observability/logger.ts';
import { type GrammarCaps, methodFor } from './method.ts';
import { vercelStructuredGenerator } from './vercel.ts';

/**
 * Google Gemini, via the AI SDK.
 *
 * Added for one stated reason: **Anthropic is expensive.** The measured Phase 9
 * live turn was 5,248 in / 27,877 out on `claude-haiku-4-5` for $0.1446, and
 * output was 96% of it. Gemini's Flash tier is roughly an order of magnitude
 * cheaper per token, which moves the same turn into cents.
 *
 * Thin, like the other two, and that is the evidence the port is real rather
 * than a shared spelling: this file makes no decisions. `effort` travels as the
 * SDK's vendor-neutral `reasoning` setting and Google resolves it its own way,
 * which is the third unrelated resolution of one domain concept.
 */

/**
 * Gemini compiles a **subset of OpenAPI 3.0 Schema**, not JSON Schema, and
 * documents omissions rather than a branchiness budget — so like OpenAI's, these
 * numbers are a shape borrowed from Anthropic's model rather than a published
 * limit, and they are **unverified against a live call**.
 *
 * Set between Anthropic's and OpenAI's: Gemini's structured output is more
 * capable than OpenAI's in practice and less battle-tested here than Anthropic's.
 * Erring low costs a degrade to `tool`, which works; erring high costs a 400 on
 * a call that has already been paid for. Re-measure before trusting.
 *
 * Tool mode does not forbid thinking, so unlike Anthropic there is no case where
 * `prompted` beats `tool`.
 */
export const GEMINI_CAPS: GrammarCaps = {
  supportsConstrained: true,
  optional: 20,
  union: 12,
  toolModeForbidsThinking: false,
};

export interface GoogleConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly logger?: Logger | undefined;
  readonly observer?: CallObserver | undefined;
}

export function googleStructuredGenerator(config: GoogleConfig): StructuredGenerator {
  const google = createGoogleGenerativeAI({ apiKey: config.apiKey });

  return vercelStructuredGenerator({
    provider: 'google',
    model: google(config.model),
    modelId: config.model,
    ...(config.logger === undefined ? {} : { logger: config.logger }),
    ...(config.observer === undefined ? {} : { observer: config.observer }),
    methodFor: (schema, effort) => methodFor(schema, GEMINI_CAPS, effort === 'high'),
    optionsFor: (method) =>
      method === 'prompted'
        ? undefined
        : { google: { structuredOutputs: method === 'constrained' } },
  });
}
