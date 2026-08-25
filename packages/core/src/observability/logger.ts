/**
 * The smallest logging surface the adapters need.
 *
 * Deliberately **not** in `domain/`: nothing there logs, and adding a logging
 * port would be the first third-party-shaped concept in a layer whose whole
 * value is depending on nothing but `zod`.
 *
 * It exists mainly to answer one question with data rather than intuition —
 * *how often does a real model return output that fails schema validation?* The
 * retry decorator logs every attempt, so the answer is grep-able after a session
 * instead of a guess.
 */

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const noop = (): void => {};

/**
 * The default. A library that logs unbidden is a library that corrupts its
 * host's stdout — the CLI and the API each decide whether to attach a real one.
 */
export const silentLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};

/** Collects entries in memory. For tests that assert *that* something was logged. */
export interface RecordingLogger extends Logger {
  readonly entries: readonly { level: string; message: string; fields: LogFields }[];
}

export function recordingLogger(): RecordingLogger {
  const entries: { level: string; message: string; fields: LogFields }[] = [];
  const at =
    (level: string) =>
    (message: string, fields: LogFields = {}): void => {
      entries.push({ level, message, fields });
    };

  return {
    entries,
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
}
