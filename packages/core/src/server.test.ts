import { describe, expect, it } from 'vitest';
import * as server from './server.ts';

/**
 * The export surface, checked as a surface.
 *
 * `check-boundaries.sh` rule 7 enforces the *shape* — re-exports only, nothing
 * declared. This enforces the *contents*: that the names an app needs are
 * actually there and actually resolve. A manifest that compiles but omits
 * `runTurn` is a manifest that fails at the first `apps/cli` import.
 */

/** Everything `apps/cli`'s composition root and commands are documented to need. */
const REQUIRED = [
  // config
  'loadConfig',
  'loadEnvFile',
  'ConfigError',
  // the loop
  'runTurn',
  'STRATEGIES',
  // adapters, by name rather than by deep path
  'REASONING_ADAPTERS',
  'TRANSCRIPTION_ADAPTERS',
  'withValidationRetry',
  'recordingStructuredGenerator',
  'withMetering',
  'createCallMeter',
  'inMemoryStores',
  'postgresStores',
  'createPostgresConnection',
  'systemClock',
  'uuidIdGenerator',
  'defaultExtractor',
  'fakeStructuredGenerator',
  'fakeTranscriber',
  'openaiTranscriber',
  'anthropicStructuredGenerator',
  'openaiStructuredGenerator',
  // ingestion
  'createIngestionService',
  'IngestionError',
  'mediaTypeFor',
  'isAudio',
  'isPlainText',
  'ingestText',
  // projection and observability
  'project',
  'silentLogger',
  'recordingLogger',
  'silentObserver',
  'recordingObserver',
  'sessionMetrics',
  'formatMetrics',
] as const;

describe('the ./server surface', () => {
  it.each(REQUIRED)('exports %s', (name) => {
    expect(server).toHaveProperty(name);
    expect((server as Record<string, unknown>)[name]).toBeDefined();
  });

  it('exports no runtime — core provides pieces, apps compose them', () => {
    // The counterpart to boundary rule 7. That rule is syntactic and catches a
    // `createRuntime` by its shape; this catches one that arrived by any other
    // route, such as a re-export from elsewhere in the package.
    const suspicious = Object.keys(server).filter((name) =>
      /^create(Runtime|App|Server)$/.test(name),
    );
    expect(suspicious).toEqual([]);
  });

  it('keeps the domain reachable without going through here', () => {
    // `./domain` stays its own entry because it is the only isomorphic half.
    // If server.ts re-exported it, a browser bundle that imported one name would
    // pull the whole Node-only graph.
    expect(server).not.toHaveProperty('Understanding');
    expect(server).not.toHaveProperty('applyDelta');
  });
});

describe('the provider registries', () => {
  it('cover every provider the config enum admits', () => {
    // Exhaustiveness is a *type* guarantee — `Record<ReasoningProvider, …>` fails
    // to compile if one is missing. This asserts the runtime side of the same
    // claim, so a cast or a widened type could not hide a gap.
    expect(Object.keys(server.REASONING_ADAPTERS).sort()).toEqual([
      'anthropic',
      'deepseek',
      'fake',
      'google',
      'openai',
    ]);
  });

  it('has no transcription entry for `none`, because it is a refusal', () => {
    // `none` means audio ingestion is *unavailable*. A null-object entry here
    // would turn refusing to transcribe into silently inventing an empty
    // transcript, which is the failure the setting exists to prevent.
    expect(Object.keys(server.TRANSCRIPTION_ADAPTERS).sort()).toEqual(['fake', 'openai']);
    expect(server.TRANSCRIPTION_ADAPTERS).not.toHaveProperty('none');
  });

  it('builds a working generator through the table', () => {
    const generator = server.REASONING_ADAPTERS.fake({ apiKey: 'unused', model: 'fake-1' });
    expect(typeof generator.generate).toBe('function');
  });
});
