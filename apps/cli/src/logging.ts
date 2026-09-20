import type { Logger } from '@requirely/core/server';

/**
 * A logger that writes as things happen.
 *
 * **Replaces a flag that did nothing.** `--verbose` swapped `silentLogger` for
 * `recordingLogger()`, which pushes entries into an in-memory array — and
 * nothing in this app ever read that array. The only readers were tests. So the
 * flag allocated a list, filled it, and dropped it, while `--help` promised
 * "record adapter logs", which was true and useless.
 *
 * Streaming rather than dumping at exit, for two reasons. A turn is two or three
 * model calls and can run for minutes, so a log you only see afterwards tells
 * you nothing while you are waiting for it. And a process that dies mid-call —
 * the interesting case — takes a buffered log with it.
 *
 * **Here rather than in `packages/core`**, for the same reason `render.ts` and
 * `clackAsker` are here: the app owns its output format. Core owns the `Logger`
 * *port* and ships only `silentLogger`, because a library that logs unbidden
 * corrupts its host's stdout.
 *
 * **stderr, not stdout.** `requirely generate <id> > spec.md` must not find log
 * lines in the document. Diagnostics and output are different streams and this
 * is exactly the case that distinction exists for.
 */
export function streamingLogger(write: (line: string) => void = toStderr): Logger {
  const at =
    (level: string) =>
    (message: string, fields: Record<string, unknown> = {}): void => {
      const detail = Object.entries(fields)
        .map(([key, value]) => `${key}=${format(value)}`)
        .join(' ');
      write(`  [${level}] ${message}${detail === '' ? '' : `  ${detail}`}\n`);
    };

  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

const toStderr = (line: string): void => {
  process.stderr.write(line);
};

/**
 * Field values, rendered so a line stays one line.
 *
 * Zod issues arrive as arrays of objects and are the single most useful field
 * here — `model output failed schema validation` carries them — but printing one
 * raw turns a log line into a screenful of JSON. Paths only: they are what names
 * the field the model got wrong, which is the whole reason to look.
 */
function format(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const paths = value
      .map((entry) => (entry as { path?: readonly unknown[] })?.path)
      .filter((path): path is readonly unknown[] => Array.isArray(path))
      .map((path) => path.join('.'));
    return paths.length > 0 ? paths.join(', ') : `[${value.length} item(s)]`;
  }
  return JSON.stringify(value) ?? String(value);
}
