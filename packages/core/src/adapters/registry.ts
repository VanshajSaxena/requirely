import type { ReasoningProvider, TranscriptionProvider } from '../config/env.ts';
import type { StructuredGenerator, Transcriber } from '../domain/index.ts';
import type { Logger } from '../observability/logger.ts';
import { anthropicStructuredGenerator } from './ai/anthropic.ts';
import { deepseekStructuredGenerator } from './ai/deepseek.ts';
import { fakeStructuredGenerator } from './ai/fake.ts';
import { googleStructuredGenerator } from './ai/google.ts';
import { openaiStructuredGenerator } from './ai/openai.ts';
import { fakeTranscriber } from './transcription/fake.ts';
import { openaiTranscriber } from './transcription/openai.ts';

/**
 * Provider name → factory, exhaustive over the config enums.
 *
 * **Why this is in core rather than in each app's composition root.** An app
 * owns wiring: lifetimes, retry, logging, shutdown, error handling. It does not
 * own the fact that `REQUIRELY_REASONING_PROVIDER` has exactly three legal
 * values — that is a fact about *this package's config schema*, and it changes
 * when a provider is added, never when an app is.
 *
 * The concrete difference is exhaustiveness. A `Record<Provider, Factory>` fails
 * to compile the day the enum grows; a ternary in `apps/cli` and another in
 * `apps/api` would both keep compiling, and one of them would be missing the new
 * provider until someone hit it at runtime.
 *
 * What an app still does, and must: choose *which* provider from config, supply
 * the credential, and wrap the result in whatever decorators it wants. None of
 * that lives here — this is a lookup table, not a runtime.
 *
 * `none` is absent from the transcription table on purpose. It is not a
 * provider that returns nothing; it means *audio ingestion is unavailable*, so
 * no transcriber is built at all and `ingestAudio` fails with a reason. Putting
 * a null-object here would turn a refusal into a silent empty transcript.
 */

export interface ProviderCredentials {
  readonly apiKey: string;
  readonly model: string;
  /**
   * Optional, and the app's to supply — core never attaches one itself.
   *
   * Same contract `withValidationRetry` already uses: a library that logs
   * unbidden corrupts its host's stdout, so silence is the default and the CLI
   * decides. This is what carries the per-call method choice to `--verbose`.
   */
  readonly logger?: Logger | undefined;
}

/**
 * Typed as a `Record` over the config enum rather than `satisfies`, because the
 * two fail in opposite directions and only one of them is the failure worth
 * catching. `satisfies Record<string, …>` rejects a *wrong* factory shape; this
 * rejects a *missing* provider, which is the one that ships.
 */
export const REASONING_ADAPTERS: Record<
  ReasoningProvider,
  (config: ProviderCredentials) => StructuredGenerator
> = {
  anthropic: (config) => anthropicStructuredGenerator(config),
  openai: (config) => openaiStructuredGenerator(config),
  google: (config) => googleStructuredGenerator(config),
  deepseek: (config) => deepseekStructuredGenerator(config),
  // Takes the same shape and ignores it, so a caller can index the table without
  // branching on which provider it happened to pick.
  fake: () => fakeStructuredGenerator(),
};

/**
 * `none` is excluded **in the type**, which is the honest way to say it is not a
 * provider that transcribes nothing — it means audio ingestion is *unavailable*.
 * A null-object entry here would turn a refusal into a silent empty transcript,
 * which is exactly the failure `REQUIRELY_TRANSCRIPTION_PROVIDER=none` exists to
 * avoid. Callers must branch on it, and `Exclude` makes them.
 */
export const TRANSCRIPTION_ADAPTERS: Record<
  Exclude<TranscriptionProvider, 'none'>,
  (config: ProviderCredentials) => Transcriber
> = {
  openai: (config) => openaiTranscriber(config),
  fake: () => fakeTranscriber(),
};
