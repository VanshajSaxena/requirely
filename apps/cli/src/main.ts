#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { clackAsker, scriptedAsker, takeFirstOption } from './asker.ts';
import { addSource } from './commands/add.ts';
import { generateDocument } from './commands/generate.ts';
import { listSessions, newSession, showStatus } from './commands/session.ts';
import { answerQuestions, runOneTurn } from './commands/turn.ts';
import { type CliRuntime, createCliRuntime } from './compose.ts';
import { temperamentFrom } from './dials.ts';
import { describeError } from './render.ts';

/**
 * The entry point.
 *
 * Argument parsing is `node:util`'s `parseArgs`, not a dependency. A CLI with
 * seven commands and eight flags does not need a framework, and the one thing a
 * framework would buy — subcommand-scoped options — is a `switch` here.
 *
 * The file does three things and no more: parse, dispatch, and make sure the
 * runtime is closed. Every command is an ordinary async function returning lines
 * to print, which is what lets the whole surface be driven from a test without
 * a process.
 */

// No backticks inside this template literal. It has broken the build twice now,
// and the failure is ERR_INVALID_TYPESCRIPT_SYNTAX from Node's type stripper
// pointing at a line of prose, which reads like anything but a quoting problem.
const USAGE = `
requirely — turn unstructured input into a specification you can build from

  new     [--title <t>] [--budget <n>] [--dials <p>]
                                            start a session
  add     <session> <file> [--label <l>]    give it something to read
  turn    <session>                         analyse what it has, and ask
  answer  <session> [--auto] [--deferred]   answer the outstanding questions
  status  <session>                         what it knows, and what it does not
  ls      [--limit <n>]                     recent sessions
  generate <session> --target <t> [--out <f>]
                                            srs | requirements-doc | agent-prompt

Dials — how Requirely should work on a session. Set once, at creation.
  --dials <p>      balanced | explorer | translator | scribe
                     balanced    neutral on everything
                     explorer    ideas, no time: expand what you said
                     translator  deep domain, no code: make it buildable
                     scribe      you have a spec: organise it faithfully
  --creativity <n>      0..1  how far past your words it reaches
  --assertiveness <n>   0..1  how much it decides without asking
  --technicality <n>    0..1  vocabulary, 0 = no jargon at all
  --thoroughness <n>    0..1  how high the bar for "enough" is
  --curiosity <n>       0..1  how many questions, how many options
  A dial given alongside --dials overrides that preset's value.

Global flags
  --provider <p>   anthropic | openai | google | deepseek | fake
  --model <m>      override the reasoning model
  --script <f>     drive the loop from a recorded script instead of a model.
                   Costs nothing. --provider fake on its own carries no script
                   and fails on the first call; this is how you use it:
                     requirely turn <id> --script apps/cli/fixtures/roomly.json
  --auto           answer by taking the first option, with no prompt. For
                   smoke tests and CI — it makes no choices worth trusting.
  --deferred       revisit the questions you skipped, instead of the open ones.
  --memory         keep everything in memory (forgets it when the process exits)
  --verbose        show what each model call chose and why, plus a preview of
                   what was sent and what came back, on stderr
  --quiet          no live status line and no call timeline; errors only
`.trim();

const OPTIONS = {
  title: { type: 'string' },
  label: { type: 'string' },
  target: { type: 'string' },
  out: { type: 'string' },
  provider: { type: 'string' },
  model: { type: 'string' },
  script: { type: 'string' },
  budget: { type: 'string' },
  dials: { type: 'string' },
  creativity: { type: 'string' },
  assertiveness: { type: 'string' },
  technicality: { type: 'string' },
  thoroughness: { type: 'string' },
  curiosity: { type: 'string' },
  limit: { type: 'string' },
  auto: { type: 'boolean' },
  deferred: { type: 'boolean' },
  memory: { type: 'boolean' },
  verbose: { type: 'boolean' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

const number = (value: string | undefined): number | undefined =>
  value === undefined ? undefined : Number.parseInt(value, 10);

async function dispatch(
  command: string,
  args: readonly string[],
  values: Record<string, string | boolean | undefined>,
  runtime: CliRuntime,
): Promise<string[]> {
  const [first, second] = args;
  const need = (name: string, value: string | undefined): string => {
    if (value === undefined) throw new Error(`\`${command}\` needs a ${name}. See --help.`);
    return value;
  };

  switch (command) {
    case 'new': {
      const temperament = temperamentFrom(values);
      return newSession(runtime, {
        title: values.title as string | undefined,
        budget: number(values.budget as string | undefined),
        ...(temperament === undefined ? {} : { temperament }),
      });
    }
    case 'ls':
      return listSessions(runtime, { limit: number(values.limit as string | undefined) });
    case 'add':
      return addSource(runtime, need('session id', first), need('file path', second), {
        label: values.label as string | undefined,
      });
    case 'turn':
      return runOneTurn(runtime, need('session id', first));
    case 'answer':
      // `--auto` is what makes a whole session scriptable without a TTY, which
      // is the only way `answer` gets exercised outside a person's hands. It
      // takes the first option every time, so it is deliberately useless as an
      // answer and honest about it in `--help`: a run driven this way proves the
      // pipeline, never the content.
      return answerQuestions(
        runtime,
        need('session id', first),
        values.auto === true ? scriptedAsker(takeFirstOption) : clackAsker(),
        { deferred: values.deferred === true },
      );
    case 'status':
      return showStatus(runtime, need('session id', first));
    case 'generate':
      return generateDocument(runtime, need('session id', first), {
        target: need('--target', values.target as string | undefined),
        out: values.out as string | undefined,
      });
    default:
      throw new Error(`Unknown command "${command}". See --help.`);
  }
}

/**
 * `process.argv.slice(2)`, minus a leading bare `--`.
 *
 * **This exists because `pnpm cli -- --help` never printed help.** The root
 * script delegates to a second `pnpm run`, and pnpm forwards the `--` verbatim
 * through the nested hop, so Node receives `['--', '--help']`. Measured against
 * `parseArgs`: a bare `--` terminates option parsing, so `--help` arrives as a
 * *positional* and `values.help` stays false. The command then fell through to
 * `dispatch` — but only after `createCliRuntime` had already tried to migrate
 * Postgres, so a help flag reported a database error.
 *
 * The fix belongs here rather than in `package.json` because `pnpm exec`
 * forwards `--` too: patching the script would move the bug, not remove it.
 *
 * Safe because the first argument to this CLI is always a command name, so a
 * leading `--` can never carry meaning. A `--` *after* a command is untouched
 * and still does what a reader expects.
 */
function argvWithoutLeadingDoubleDash(): string[] {
  const argv = process.argv.slice(2);
  return argv[0] === '--' ? argv.slice(1) : argv;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argvWithoutLeadingDoubleDash(),
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });

  const [command, ...rest] = positionals;
  if (command === undefined || values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const runtime = await createCliRuntime({
    provider: values.provider,
    model: values.model,
    script: values.script,
    // Postgres by default, because a CLI whose commands are separate processes
    // needs storage that outlives one. `--memory` is for tests and for seeing
    // the shape of a session without standing anything up; it is honest about
    // forgetting, which a silent in-memory default would not be.
    storage: values.memory === true ? 'memory' : 'postgres',
    verbose: values.verbose,
    quiet: values.quiet,
    // The first positional of every command but `new` and `ls` is the session
    // id, which is what makes a run directory findable later.
    ...(rest[0] === undefined ? {} : { sessionId: rest[0] }),
  });

  try {
    const lines = await dispatch(command, rest, values, runtime);
    // Before the write, not after: the status line redraws on a timer, and a
    // frame landing between these two calls would be stamped across the output.
    runtime.status.clear();
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } finally {
    // In a `finally` rather than after the write: a command that throws must
    // still release the Postgres pool, or the process hangs on the way out and
    // the user sees a stack trace followed by nothing.
    await runtime.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // A CLI's job at this point is to say what went wrong, not to prove it has a
    // stack. `--verbose` is where the detail lives.
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
  });
