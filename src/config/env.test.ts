import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './env.ts';

// `fake` needs no credential, so it is the baseline for tests that are not
// about credential resolution.
const FAKE_PROVIDERS = {
  REQUIRELY_REASONING_PROVIDER: 'fake',
  REQUIRELY_TRANSCRIPTION_PROVIDER: 'fake',
} as const;

describe('loadConfig', () => {
  it('applies documented defaults when only credentials are supplied', () => {
    const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-test', OPENAI_API_KEY: 'sk-test' });

    expect(config.reasoning).toEqual({ provider: 'anthropic', model: 'claude-opus-5' });
    expect(config.transcription).toEqual({ provider: 'openai', model: 'whisper-1' });
    expect(config.questionBudget).toBe(12);
    expect(config.nodeEnv).toBe('development');
  });

  it('resolves reasoning and transcription providers independently', () => {
    const config = loadConfig({
      REQUIRELY_REASONING_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-a',
      REQUIRELY_TRANSCRIPTION_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-o',
    });

    expect(config.reasoning.provider).toBe('anthropic');
    expect(config.transcription.provider).toBe('openai');
  });

  it('fails at startup when a selected provider has no credential', () => {
    expect(() => loadConfig({ REQUIRELY_REASONING_PROVIDER: 'anthropic' })).toThrow(ConfigError);

    try {
      loadConfig({ REQUIRELY_REASONING_PROVIDER: 'anthropic' });
    } catch (error) {
      expect((error as ConfigError).issues.join()).toContain('ANTHROPIC_API_KEY');
    }
  });

  it('requires no credential for the fake provider', () => {
    expect(() => loadConfig(FAKE_PROVIDERS)).not.toThrow();
  });

  it('coerces the question budget and rejects non-positive values', () => {
    expect(loadConfig({ ...FAKE_PROVIDERS, REQUIRELY_QUESTION_BUDGET: '5' }).questionBudget).toBe(
      5,
    );
    expect(() => loadConfig({ ...FAKE_PROVIDERS, REQUIRELY_QUESTION_BUDGET: '0' })).toThrow(
      ConfigError,
    );
  });

  it('rejects an unknown provider rather than falling back silently', () => {
    expect(() => loadConfig({ REQUIRELY_REASONING_PROVIDER: 'mistral' })).toThrow(ConfigError);
  });
});
