import { z } from 'zod';

/**
 * Configuration is shaped by capability, not by vendor.
 *
 * The architecture allows a different provider at each layer, so reasoning and
 * transcription are resolved independently rather than through a single global
 * "provider" switch. Adding a capability means adding a block here; adding a
 * provider means extending one enum.
 */

const ReasoningProvider = z.enum(['anthropic', 'openai', 'fake']);
const TranscriptionProvider = z.enum(['openai', 'fake', 'none']);
const TurnStrategy = z.enum(['separate', 'merged']);

export type ReasoningProvider = z.infer<typeof ReasoningProvider>;
export type TranscriptionProvider = z.infer<typeof TranscriptionProvider>;
export type TurnStrategy = z.infer<typeof TurnStrategy>;

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.string().min(1).optional(),

  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),

  REQUIRELY_REASONING_PROVIDER: ReasoningProvider.default('anthropic'),
  REQUIRELY_REASONING_MODEL: z.string().min(1).default('claude-opus-5'),

  /**
   * `none` means **audio ingestion is unavailable** — no transcriber is built,
   * and `ingestAudio` fails with an `IngestionError` naming the reason.
   *
   * It exists because the check below is eager, which is right in principle and
   * was conflating two different things: a *configured* provider and a provider
   * that will actually be used. With `openai` as the only real option, a
   * text-only session run with an Anthropic key alone died at startup demanding
   * `OPENAI_API_KEY` for a capability it was never going to touch.
   *
   * Not `fake`, which would also have "worked": a fake transcriber silently
   * returns scripted text, so the failure moves from startup into the
   * Understanding, where it looks like something a user said. Refusing to
   * transcribe beats inventing a transcript.
   */
  REQUIRELY_TRANSCRIPTION_PROVIDER: TranscriptionProvider.default('openai'),
  REQUIRELY_TRANSCRIPTION_MODEL: z.string().min(1).default('whisper-1'),

  REQUIRELY_QUESTION_BUDGET: z.coerce.number().int().positive().default(12),

  /**
   * `separate` scores the understanding the domain actually stored (3 calls per
   * turn). `merged` folds analyze and assess into one call, sending the
   * understanding once — roughly a third fewer tokens, at the cost of scoring a
   * predicted merge rather than the real one. Both exist so the trade can be
   * measured on a fixture session instead of argued about.
   */
  REQUIRELY_TURN_STRATEGY: TurnStrategy.default('separate'),

  /**
   * A turn that asks everything at once is a questionnaire, not a loop. The
   * budget is the session total; this caps a single round.
   */
  REQUIRELY_MAX_QUESTIONS_PER_TURN: z.coerce.number().int().positive().default(4),
});

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  readonly databaseUrl: string | undefined;
  readonly questionBudget: number;
  readonly maxQuestionsPerTurn: number;
  readonly turnStrategy: TurnStrategy;
  readonly reasoning: { readonly provider: ReasoningProvider; readonly model: string };
  readonly transcription: { readonly provider: TranscriptionProvider; readonly model: string };
  readonly credentials: {
    readonly anthropic: string | undefined;
    readonly openai: string | undefined;
  };
}

export class ConfigError extends Error {
  // Declared explicitly rather than as a constructor parameter property:
  // parameter properties are not erasable syntax, so Node cannot strip them.
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Credential each provider needs, so a missing key fails at startup rather than mid-session. */
const CREDENTIAL_FOR = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  fake: null,
  // Needs no credential because it makes no calls — see the note on
  // REQUIRELY_TRANSCRIPTION_PROVIDER above.
  none: null,
} as const satisfies Record<string, string | null>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const env = parsed.data;

  const missing: string[] = [];
  const requireCredential = (provider: keyof typeof CREDENTIAL_FOR, capability: string): void => {
    const key = CREDENTIAL_FOR[provider];
    if (key !== null && !source[key]) {
      missing.push(`${key} is required because ${capability} uses the "${provider}" provider`);
    }
  };
  requireCredential(env.REQUIRELY_REASONING_PROVIDER, 'reasoning');
  requireCredential(env.REQUIRELY_TRANSCRIPTION_PROVIDER, 'transcription');
  if (missing.length > 0) throw new ConfigError(missing);

  return {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    questionBudget: env.REQUIRELY_QUESTION_BUDGET,
    maxQuestionsPerTurn: env.REQUIRELY_MAX_QUESTIONS_PER_TURN,
    turnStrategy: env.REQUIRELY_TURN_STRATEGY,
    reasoning: {
      provider: env.REQUIRELY_REASONING_PROVIDER,
      model: env.REQUIRELY_REASONING_MODEL,
    },
    transcription: {
      provider: env.REQUIRELY_TRANSCRIPTION_PROVIDER,
      model: env.REQUIRELY_TRANSCRIPTION_MODEL,
    },
    credentials: {
      anthropic: env.ANTHROPIC_API_KEY,
      openai: env.OPENAI_API_KEY,
    },
  };
}

/** Loads `.env` if present. Node 24 provides this natively; no dotenv dependency. */
export function loadEnvFile(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // Absent .env is normal — real environments inject variables directly.
  }
}
