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
  type CallObserver,
  createIngestionService,
  createPostgresConnection,
  credentialFor,
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
  STRATEGIES,
  silentLogger,
  systemClock,
  TRANSCRIPTION_ADAPTERS,
  uuidIdGenerator,
  withValidationRetry,
} from '@requirely/core/server';
import { createStatusObserver, createTimeline, fanOut } from './observe.ts';
import { createRunLog, type RunLog } from './runlog.ts';
import { createStatusLine, type StatusLine, silentStatusLine } from './status.ts';

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

import { streamingLogger } from './logging.ts';

/** `.env` lives at the repo root, three directories up from `apps/cli/src`. */
const REPO_ENV = join(import.meta.dirname, '../../../.env');

/**
 * Where run payloads land.
 *
 * Module-relative, like `REPO_ENV` and for the same reason: the CLI is reached
 * through `bin/requirely` from any directory, and a cwd-relative path would
 * scatter a `.requirely/` into every one of them. `REQUIRELY_RUN_LOG_DIR`
 * overrides, for anyone who wants it under `$XDG_STATE_HOME` instead.
 */
const RUN_LOG_DIR =
  process.env.REQUIRELY_RUN_LOG_DIR ?? join(import.meta.dirname, '../../../.requirely/runs');

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
  /**
   * The live phase line. Commands drive it directly for the slow work the
   * `CallObserver` cannot see — the migration, the commit transaction — because
   * those are call sites this app owns and an app needs no event to talk to
   * itself.
   */
  readonly status: StatusLine;
  /** Where this run's payloads are being written, or null when capture is off. */
  readonly runLog: RunLog | null;
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
  /** Suppress the live status line and the call timeline. Errors still print. */
  readonly quiet?: boolean | undefined;
  /** The session this run belongs to, so the run directory is findable by id. */
  readonly sessionId?: string | undefined;
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
  const quiet = options.quiet === true;
  const verbose = options.verbose === true;

  // Streaming, not recording. `recordingLogger()` filled an array this app never
  // read, so `--verbose` was inert for as long as it has existed.
  //
  // Three states, not two. `--quiet` silences; `--verbose` drops the floor to
  // `debug` so the per-call method choice appears; otherwise `LOG_LEVEL` decides
  // — which at its `info` default still surfaces a retry recovering, the one
  // thing worth knowing about without having asked for it.
  const logger = quiet
    ? silentLogger
    : streamingLogger(undefined, verbose ? 'debug' : config.logLevel);

  // Three sinks, fanned out from one stream. Quiet drops the two that draw on
  // the terminal and keeps the one that writes to disk — and because the run log
  // creates nothing until an event arrives, a quiet run that calls no provider
  // still leaves no trace.
  const status = quiet ? silentStatusLine : createStatusLine();
  const runLog = createRunLog({
    dir: RUN_LOG_DIR,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    redact: redactSecrets,
  });
  const observer: CallObserver = quiet
    ? runLog
    : fanOut(createStatusObserver(status), createTimeline({ payloads: verbose }), runLog);

  // `credentialFor`, not a ternary. The version here was
  //   `provider === 'openai' ? credentials.openai : credentials.anthropic`
  // — an `else` branch over a growing enum. Adding Gemini would have shipped the
  // *Anthropic* key to Google and failed with an auth error naming the wrong
  // problem. Core owns the mapping because the enum is core's, and a `Record`
  // over it makes a forgotten provider a compile error rather than a runtime
  // surprise in whichever app forgot — exactly why `REASONING_ADAPTERS` is a
  // `Record` too.
  const credential = credentialFor(config);

  // Indexing an exhaustive table rather than a ternary per app: `ReasoningProvider`
  // is a closed enum owned by core's config schema, so adding a provider is a
  // compile error there rather than a runtime surprise in whichever app forgot.
  const generator = withValidationRetry(
    options.script === undefined
      ? REASONING_ADAPTERS[config.reasoning.provider]({
          apiKey: credential ?? 'unused-by-this-provider',
          model: config.reasoning.model,
          // Which method each call chose, and why. `withValidationRetry` below
          // already had a logger; the adapter did not, so nothing reported the
          // one decision that explains a provider rejecting a schema.
          logger,
          // What went out and what came back, per call, as it happens.
          observer,
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
          // The slowest opaque wait in the product: an hour of audio otherwise
          // leaves `requirely add` silent with nothing to show it is alive.
          observer,
        });

  // Framed by the app, not by an event: `connection.migrate()` runs on every
  // Postgres command and takes hundreds of milliseconds to seconds, and it is
  // the first thing a user waits on. There is no port to emit from and no need
  // for one — this is a call site the CLI owns.
  if (options.storage !== 'memory') status.begin('Connecting to Postgres');
  const { stores, close } = await selectStorage(options.storage ?? 'memory', config);
  status.clear();
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
    status,
    runLog,
    close: async (): Promise<void> => {
      // Before storage, and unconditionally: a status line still animating when
      // the process exits leaves a half-drawn frame as the last thing on screen.
      status.clear();
      await close();
    },
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

/**
 * Blank any embedded credential inside a larger body of text.
 *
 * **Not `redact`.** That one parses its whole argument as a URL and returns
 * `(unparseable DATABASE_URL)` for anything that is not one — correct for the
 * connection-failure message, catastrophic for a log line, where it would
 * replace every record with that string. Two jobs that read alike and behave
 * oppositely, which is why they are two named functions rather than one with a
 * flag.
 *
 * A connection error can carry the DSN into a `call.fail` reason, and the run
 * log is written to disk and likely to be shared. API keys never reach a
 * `CallEvent` at all — they live on the adapter config — so this is the only
 * secret shape that can arrive here.
 */
function redactSecrets(text: string): string {
  // scheme://user:secret@host  →  scheme://user:***@host
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]*@/gi, '$1:***@');
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
