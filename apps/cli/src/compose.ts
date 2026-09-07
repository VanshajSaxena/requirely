import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_SUFFICIENCY_POLICY,
  type InquiryRepository,
  type SessionRepository,
  type SourceRepository,
  type TurnCommitter,
  type UnderstandingRepository,
} from '@requirely/core/domain';
import {
  type AppConfig,
  createIngestionService,
  createPostgresConnection,
  defaultExtractor,
  type EngineDeps,
  type FakeScript,
  fakeStructuredGenerator,
  inMemoryStores,
  type Logger,
  loadConfig,
  loadEnvFile,
  postgresStores,
  REASONING_ADAPTERS,
  recordingLogger,
  STRATEGIES,
  silentLogger,
  systemClock,
  TRANSCRIPTION_ADAPTERS,
  uuidIdGenerator,
  withValidationRetry,
} from '@requirely/core/server';

/**
 * **The composition root. The only one.**
 *
 * Core exports pieces and contracts; this is where an application decides what
 * to build out of them. An earlier draft put a `createRuntime()` inside
 * `packages/core`, and the reason that was wrong is visible here: every choice
 * below is a *CLI* choice. A future `apps/api` will make different ones — pino
 * instead of a recording logger, a pool that outlives a request, HTTP error
 * mapping — in its own `compose.ts`, sharing nothing but the pieces.
 *
 * Three things this owns that core deliberately does not:
 *
 * - **Which provider.** Read from config, looked up in core's exhaustive
 *   registry. The registry is core's because the enum is core's; the *choice* is
 *   the app's.
 * - **Which decorators.** `withValidationRetry`, and nothing else. Recording
 *   belongs to a test harness and metering to an eval; wrapping them in
 *   unconditionally would make every command pay for a measurement nobody asked
 *   for.
 * - **Lifetime.** A CLI command is a process. `close()` exists so a Postgres
 *   pool does not keep it alive after the work is done.
 */

/** `.env` lives at the repo root, three directories up from `apps/cli/src`. */
const REPO_ENV = join(import.meta.dirname, '../../../.env');

/**
 * What the commands need from storage.
 *
 * Named here rather than borrowed from an adapter's return type: the CLI depends
 * on the *ports*, and `ReturnType<typeof inMemoryStores>` would make one
 * adapter's shape the contract — so the Postgres path only fits through a cast,
 * which is the compiler saying the abstraction was the wrong way round.
 */
export interface CliStores {
  readonly sessions: SessionRepository;
  readonly sources: SourceRepository;
  readonly understanding: UnderstandingRepository;
  readonly inquiry: InquiryRepository;
  readonly committer: TurnCommitter;
}

export interface CliRuntime {
  readonly config: AppConfig;
  readonly deps: EngineDeps;
  /**
   * Outside `EngineDeps` on purpose: `runTurn` never writes, and keeping the
   * committer out of what it receives is what makes that unexpressible rather
   * than merely true.
   */
  readonly committer: TurnCommitter;
  readonly stores: CliStores;
  readonly ingestion: ReturnType<typeof createIngestionService>;
  readonly logger: Logger;
  close(): Promise<void>;
}

export interface RuntimeOptions {
  /** Overrides `REQUIRELY_REASONING_PROVIDER`. Pair `fake` with `script`. */
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  /**
   * Defaults to `postgres` at the entry point.
   *
   * A CLI's commands are separate processes, so in-memory storage means every
   * command starts with an empty store and `new` → `add` cannot work at all.
   * That is a fine default for a test driving one process and a broken one for a
   * user, so the entry point chooses `postgres` and `--memory` is explicit.
   */
  readonly storage?: 'memory' | 'postgres' | undefined;
  readonly verbose?: boolean | undefined;
  /**
   * Path to a recorded script. When set, the loop is driven from the file
   * instead of from a provider — see `scriptedGenerator`.
   */
  readonly script?: string | undefined;
}

/**
 * Loads config, chooses storage, and builds everything a command needs.
 *
 * **`loadEnvFile` is given an explicit path.** It resolves against
 * `process.cwd()` and swallows a missing file, so a CLI invoked from anywhere
 * but `packages/core` would silently see no configuration and fail later with a
 * message about a missing API key. An entry point is the only code that knows
 * where it sits, which is why this is its job and not the library's.
 */
export async function createCliRuntime(options: RuntimeOptions = {}): Promise<CliRuntime> {
  loadEnvFile(REPO_ENV);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.provider === undefined ? {} : { REQUIRELY_REASONING_PROVIDER: options.provider }),
    ...(options.model === undefined ? {} : { REQUIRELY_REASONING_MODEL: options.model }),
  };
  const config = loadConfig(env);
  const logger = options.verbose === true ? recordingLogger() : silentLogger;

  const credential =
    config.reasoning.provider === 'openai'
      ? config.credentials.openai
      : config.credentials.anthropic;

  // Indexing an exhaustive table rather than a ternary per app: `ReasoningProvider`
  // is a closed enum owned by core's config schema, so adding a provider is a
  // compile error there rather than a runtime surprise in whichever app forgot.
  const generator = withValidationRetry(
    options.script === undefined
      ? REASONING_ADAPTERS[config.reasoning.provider]({
          apiKey: credential ?? 'unused-by-this-provider',
          model: config.reasoning.model,
        })
      : await scriptedGenerator(options.script),
    { logger },
  );

  // `none` is absent from the transcription registry **by type**, so this branch
  // is not defensive — it is the only way to express "audio ingestion is
  // unavailable" without inventing a transcriber that returns nothing.
  const transcriber =
    config.transcription.provider === 'none'
      ? undefined
      : TRANSCRIPTION_ADAPTERS[config.transcription.provider]({
          apiKey: config.credentials.openai ?? 'unused-by-this-provider',
          model: config.transcription.model,
        });

  const { stores, close } = await selectStorage(options.storage ?? 'memory', config);
  const clock = systemClock();

  return {
    config,
    deps: {
      generator,
      sessions: stores.sessions,
      sources: stores.sources,
      revisions: stores.understanding,
      inquiry: stores.inquiry,
      clock,
      ids: uuidIdGenerator(),
      policy: DEFAULT_SUFFICIENCY_POLICY,
      strategy: STRATEGIES[config.turnStrategy],
      maxQuestionsPerTurn: config.maxQuestionsPerTurn,
    },
    committer: stores.committer,
    stores,
    ingestion: createIngestionService({
      sources: stores.sources,
      clock,
      extractor: defaultExtractor(),
      ...(transcriber === undefined ? {} : { transcriber }),
    }),
    logger,
    close,
  };
}

/**
 * Storage, and the one thing that differs with it.
 *
 * The two backends are interchangeable through the ports — that is what the
 * shared contract suite proves — so the only thing this really selects is
 * whether `close()` has work to do. A command that forgets to close a pool
 * hangs; a command that closes nothing cannot.
 */
async function selectStorage(
  kind: 'memory' | 'postgres',
  config: AppConfig,
): Promise<{ stores: CliStores; close: () => Promise<void> }> {
  if (kind === 'memory') {
    return { stores: inMemoryStores(), close: async () => {} };
  }

  const url = config.databaseUrl;
  if (url === undefined) {
    throw new Error(
      [
        'DATABASE_URL is not set, so there is nowhere to keep a session.',
        '  · start Postgres:  docker compose up -d',
        '  · or run without persistence:  requirely <command> --memory',
        '    (--memory forgets everything when the command exits, so `new` then `add` will not work)',
      ].join('\n'),
    );
  }

  const connection = createPostgresConnection(url);

  // Error handling is an application's job, and this is what that means
  // concretely: a first run against a stopped database otherwise prints
  // `Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"`, which tells a user
  // nothing they can act on. The library is right not to guess at a remedy — it
  // does not know a `docker-compose.yml` exists. The app does.
  try {
    await connection.migrate();
  } catch (error) {
    await connection.close().catch(() => {});
    throw new Error(
      [
        `Could not reach Postgres at ${redact(url)}.`,
        '  · start it:  docker compose up -d',
        '  · or run without persistence:  requirely <command> --memory',
        `  · the driver said: ${error instanceof Error ? error.message : String(error)}`,
      ].join('\n'),
      { cause: error },
    );
  }

  return { stores: postgresStores(connection.db), close: () => connection.close() };
}

/**
 * A generator driven by a file instead of by a provider.
 *
 * **This is what makes `--provider fake` mean anything from a terminal.** The
 * registry entry is `fake: () => fakeStructuredGenerator()` — an *empty* script —
 * so the flag `--help` advertised as costing nothing actually failed on the first
 * `analyze` call. The registry is not wrong: a fake that invented plausible
 * content on demand would be the same lie as a `fake` transcriber, which this
 * codebase already refused in favour of a `none` provider that fails loudly. What
 * was missing is a way to *supply* the script, and supplying it is an application
 * concern — the file path is a CLI argument, not a fact about the enum.
 *
 * The script is validated against the real schemas by `fakeStructuredGenerator`
 * itself, so a fixture that drifts from the domain fails here exactly as a real
 * model's malformed output would.
 */
async function scriptedGenerator(
  path: string,
): Promise<ReturnType<typeof fakeStructuredGenerator>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Could not read the script at ${path}. There is one committed at apps/cli/fixtures/roomly.json.`,
      { cause: error },
    );
  }

  try {
    return fakeStructuredGenerator(JSON.parse(text) as FakeScript);
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Never print a connection string with its password in it. */
function redact(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}
