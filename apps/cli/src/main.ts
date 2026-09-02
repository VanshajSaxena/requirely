#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { clackAsker } from './asker.ts';
import { addSource } from './commands/add.ts';
import { generateDocument } from './commands/generate.ts';
import { listSessions, newSession, showStatus } from './commands/session.ts';
import { answerQuestions, runOneTurn } from './commands/turn.ts';
import { type CliRuntime, createCliRuntime } from './compose.ts';

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

const USAGE = `
requirely — turn unstructured input into a specification you can build from

  new     [--title <t>] [--budget <n>]      start a session
  add     <session> <file> [--label <l>]    give it something to read
  turn    <session>                         analyse what it has, and ask
  answer  <session>                         answer the outstanding questions
  status  <session>                         what it knows, and what it does not
  ls      [--limit <n>]                     recent sessions
  generate <session> --target <t> [--out <f>]
                                            srs | requirements-doc | agent-prompt

Global flags
  --provider <p>   anthropic | openai | fake   (fake costs nothing)
  --model <m>      override the reasoning model
  --memory         keep everything in memory (forgets it when the process exits)
  --verbose        record adapter logs
`.trim();

const OPTIONS = {
  title: { type: 'string' },
  label: { type: 'string' },
  target: { type: 'string' },
  out: { type: 'string' },
  provider: { type: 'string' },
  model: { type: 'string' },
  budget: { type: 'string' },
  limit: { type: 'string' },
  memory: { type: 'boolean' },
  verbose: { type: 'boolean' },
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
    case 'new':
      return newSession(runtime, {
        title: values['title'] as string | undefined,
        budget: number(values['budget'] as string | undefined),
      });
    case 'ls':
      return listSessions(runtime, { limit: number(values['limit'] as string | undefined) });
    case 'add':
      return addSource(runtime, need('session id', first), need('file path', second), {
        label: values['label'] as string | undefined,
      });
    case 'turn':
      return runOneTurn(runtime, need('session id', first));
    case 'answer':
      return answerQuestions(runtime, need('session id', first), clackAsker());
    case 'status':
      return showStatus(runtime, need('session id', first));
    case 'generate':
      return generateDocument(runtime, need('session id', first), {
        target: need('--target', values['target'] as string | undefined),
        out: values['out'] as string | undefined,
      });
    default:
      throw new Error(`Unknown command "${command}". See --help.`);
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
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
    // Postgres by default, because a CLI whose commands are separate processes
    // needs storage that outlives one. `--memory` is for tests and for seeing
    // the shape of a session without standing anything up; it is honest about
    // forgetting, which a silent in-memory default would not be.
    storage: values.memory === true ? 'memory' : 'postgres',
    verbose: values.verbose,
  });

  try {
    const lines = await dispatch(command, rest, values, runtime);
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
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
