import { describe, expect, it } from 'vitest';
import { ConfigError, credentialFor, loadConfig } from './env.ts';

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

  it("lets a text-only session run on one vendor without the other vendor's key", () => {
    // The bug this closes: transcription defaults to `openai` and the credential
    // check is unconditional, so an Anthropic-only setup died at startup over a
    // capability it was never going to reach.
    expect(() =>
      loadConfig({
        REQUIRELY_REASONING_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'sk-a',
        REQUIRELY_TRANSCRIPTION_PROVIDER: 'none',
      }),
    ).not.toThrow();
  });

  it('still fails eagerly for a provider that will make calls', () => {
    // `none` narrows the eager check, it does not weaken it: choosing a real
    // provider without its key must still fail at startup rather than mid-session.
    expect(() =>
      loadConfig({
        REQUIRELY_REASONING_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'sk-a',
        REQUIRELY_TRANSCRIPTION_PROVIDER: 'openai',
      }),
    ).toThrow(ConfigError);
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

describe('credentialFor', () => {
  /**
   * **This exists because `apps/cli` was picking the key with a ternary** —
   * `provider === 'openai' ? openai : anthropic` — an `else` branch over a
   * growing enum. Adding Gemini would have shipped the Anthropic key to Google
   * and failed with an auth error naming the wrong problem.
   */
  const KEYS = {
    ANTHROPIC_API_KEY: 'ant',
    OPENAI_API_KEY: 'oai',
    GOOGLE_API_KEY: 'goog',
    DEEPSEEK_API_KEY: 'ds',
  } as const;

  const forProvider = (provider: string) =>
    credentialFor(
      loadConfig({
        ...KEYS,
        REQUIRELY_REASONING_PROVIDER: provider,
        REQUIRELY_TRANSCRIPTION_PROVIDER: 'none',
      }),
    );

  it('hands each provider its own key and never a neighbour’s', () => {
    expect(forProvider('anthropic')).toBe('ant');
    expect(forProvider('openai')).toBe('oai');
    expect(forProvider('google')).toBe('goog');
    expect(forProvider('deepseek')).toBe('ds');
  });

  it('gives the fake provider nothing, because it makes no calls', () => {
    expect(forProvider('fake')).toBeUndefined();
  });

  it('still fails at startup when the chosen provider has no key', () => {
    // The lookup is not a substitute for the eager check: a missing key must be
    // a startup error, not a 401 three model calls into a paid turn.
    expect(() =>
      loadConfig({
        REQUIRELY_REASONING_PROVIDER: 'google',
        REQUIRELY_TRANSCRIPTION_PROVIDER: 'none',
      }),
    ).toThrow(ConfigError);
  });
});
