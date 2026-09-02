/**
 * The server-side surface of `@requirely/core`.
 *
 * **Re-exports only. There is deliberately no `createRuntime()` here, and no
 * `src/app/` for one to live in.** An earlier draft of Phase 7 put a composition
 * root inside this package, and it was wrong for a reason worth keeping: a
 * library that knows how to assemble itself knows about its applications. The
 * moment a second app appears it grows flags, or splits into
 * `createRuntimeForCLI` / `createRuntimeForServer`, and every app inherits
 * decisions about lifetime, retry and shutdown that belong to the app.
 *
 * So core exports **pieces and contracts**; each app has exactly one composition
 * root and owns its own wiring. `apps/cli/src/compose.ts` is the first.
 *
 * The rule is executable: `scripts/check-boundaries.sh` rule 7 fails if any
 * non-comment line in this file does not begin with `export`. The day someone
 * adds a function here, CI says so — which is the difference between a
 * constraint and a paragraph.
 *
 * **One entry, not per-directory subpaths**, for the same reason `./domain` is
 * one entry: the public surface should be a decision someone made, not a side
 * effect of the folder layout.
 *
 * `./domain` remains separate and is the *only* thing a browser may import —
 * everything below is Node-only.
 */

export {
  type AnthropicConfig,
  anthropicStructuredGenerator,
} from './adapters/ai/anthropic.ts';
export { type FakeScript, fakeStructuredGenerator } from './adapters/ai/fake.ts';
export { type CallMeter, createCallMeter, withMetering } from './adapters/ai/metering.ts';
export { type OpenAIConfig, openaiStructuredGenerator } from './adapters/ai/openai.ts';
export { type RecordingOptions, recordingStructuredGenerator } from './adapters/ai/recording.ts';
export { type RetryOptions, withValidationRetry } from './adapters/ai/retry.ts';
export { defaultExtractor } from './adapters/extraction/composite.ts';
export {
  type ProviderCredentials,
  REASONING_ADAPTERS,
  TRANSCRIPTION_ADAPTERS,
} from './adapters/registry.ts';
export { inMemoryStores } from './adapters/storage/memory.ts';
export {
  createPostgresConnection,
  type PostgresConnection,
} from './adapters/storage/postgres/client.ts';
export { postgresStores } from './adapters/storage/postgres/repositories.ts';
export { systemClock } from './adapters/system/clock.ts';
export { uuidIdGenerator } from './adapters/system/ids.ts';
export { fakeTranscriber } from './adapters/transcription/fake.ts';
export { openaiTranscriber } from './adapters/transcription/openai.ts';
export {
  type AppConfig,
  ConfigError,
  loadConfig,
  loadEnvFile,
  type ReasoningProvider,
  type TranscriptionProvider,
  type TurnStrategy,
} from './config/env.ts';
export { type EngineDeps, runTurn, type TurnRequest } from './engine/loop.ts';
export { STRATEGIES, type StrategyName } from './engine/strategies.ts';
export { isAudio, isPlainText, mediaTypeFor } from './ingestion/media-type.ts';
export { createIngestionService, IngestionError } from './ingestion/service.ts';
export { ingestText } from './ingestion/text.ts';
export { type Logger, recordingLogger, silentLogger } from './observability/logger.ts';
export {
  formatMetrics,
  type SessionMetrics,
  sessionMetrics,
} from './observability/session-metrics.ts';
export { project } from './projection/index.ts';
export type { Projection, ProjectionInput } from './projection/types.ts';
