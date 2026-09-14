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

describe('an empty variable means absent', () => {
  /**
   * **This shipped as a bug and broke on the most ordinary action available.**
   * `.env.example` lists every credential with an empty value, so copying it to
   * `.env` — or adding a placeholder line for a provider you have not signed up
   * for yet — made `loadConfig` throw, taking out every CLI command and eleven
   * tests, with an error naming a key the session was never going to use.
   *
   * `z.string().min(1).optional()` was the cause: `.optional()` admits
   * `undefined`, and `KEY=` is present and equal to `""`.
   */
  it('does not reject a credential written with no value', () => {
    expect(() =>
      loadConfig({
        ...FAKE_PROVIDERS,
        DEEPSEEK_API_KEY: '',
        GOOGLE_API_KEY: '',
        DATABASE_URL: '',
      }),
    ).not.toThrow();
  });

  it('reports an empty variable as undefined, not as an empty string', () => {
    // A caller branching on `credentials.deepseek !== undefined` must see the
    // same thing whether the line is absent or blank.
    const config = loadConfig({ ...FAKE_PROVIDERS, DEEPSEEK_API_KEY: '', DATABASE_URL: '' });
    expect(config.credentials.deepseek).toBeUndefined();
    expect(config.databaseUrl).toBeUndefined();
  });

  it('treats a whitespace-only value the same way', () => {
    // Worse than empty if left alone: it passes `.min(1)` and reaches the
    // provider as whitespace, coming back as an authentication error rather
    // than a configuration one.
    expect(
      loadConfig({ ...FAKE_PROVIDERS, OPENAI_API_KEY: '   ' }).credentials.openai,
    ).toBeUndefined();
  });

  it('still fails when the chosen provider has a blank key rather than a missing one', () => {
    // The eager credential check must not be weakened by this: a blank key for
    // the provider you actually selected is still a startup error.
    expect(() =>
      loadConfig({
        REQUIRELY_REASONING_PROVIDER: 'google',
        REQUIRELY_TRANSCRIPTION_PROVIDER: 'none',
        GOOGLE_API_KEY: '',
      }),
    ).toThrow(ConfigError);
  });

  it('trims a value that is set, so a stray newline cannot reach a provider', () => {
    expect(
      loadConfig({ ...FAKE_PROVIDERS, ANTHROPIC_API_KEY: '  sk-ant-xyz  ' }).credentials.anthropic,
    ).toBe('sk-ant-xyz');
  });
});
