/**
 * The line that says something is still happening.
 *
 * **The problem it solves is structural, not cosmetic.** `main.ts` collects a
 * command's output into a `string[]` and writes it once, after the command
 * returns. A turn is two or three provider calls with `analyze` at
 * `effort: 'high'`, so the CLI is silent for minutes and then prints everything
 * at once. Nothing is stuck; nothing says so either.
 *
 * **stderr, always.** `requirely generate <id> > spec.md` must not find a
 * spinner frame in the document, and `generate` returns the whole document as
 * its only line. This is the same rule `logging.ts` follows and the same reason.
 *
 * **Hand-rolled rather than `clack.spinner`**, which does exist at the installed
 * 1.7.0 and does offer `indicator: 'timer'`. Three reasons, in order of weight:
 * an injected writer is how this repo tests output (`logging.test.ts` exists
 * only to pin that the writer is called) and a clack frame cannot be tested that
 * way; clack draws its own guide rails and symbol set into a CLI whose
 * `render.ts` has no glyphs at all; and `asker.ts` already owns a clack frame
 * during `answer`, so a second one would be two libraries managing one cursor.
 */

const ESC = '\u001b[';
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;
/** Return to column 0 and clear to end of line — one frame, no scrollback. */
const CLEAR_LINE = `\r${ESC}K`;

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const TICK_MS = 100;

export interface StatusOptions {
  readonly write?: (text: string) => void;
  /**
   * Whether the writer's destination can be redrawn in place.
   *
   * Probed on **stderr**, not stdout. `render.ts` checks `process.stdout.isTTY`
   * because it is deciding about colour in the document channel; this is the
   * diagnostic channel, and `requirely generate <id> > spec.md` redirects only
   * stdout — stderr is still a terminal and still wants a live line.
   */
  readonly interactive?: boolean;
  readonly colour?: boolean;
}

export interface StatusLine {
  /** Open a phase. Replaces any phase already running. */
  begin(label: string): void;
  /** Change the label without restarting the clock. */
  update(label: string): void;
  /** Close the current phase, leaving `summary` behind permanently. */
  end(summary: string): void;
  /** Close the current phase, leaving nothing behind. */
  clear(): void;
}

/**
 * Elapsed time, rendered the way the reference harness does it.
 *
 * `8s` below a minute, `1m05s` at or above one. Seconds are zero-padded in the
 * minute form so the column does not jitter while you watch it.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}

/**
 * A status line that says nothing.
 *
 * **Not the same as a non-interactive one, and conflating the two was a bug.**
 * `--quiet` first set `interactive: false`, which selects the *fallback* — one
 * plain line per phase — so the flag that means "say nothing" printed a line
 * for every phase into the test suite's output. "There is no cursor to move"
 * and "do not speak" are different questions and only one of them is `quiet`.
 *
 * Same shape as `silentLogger` and `silentObserver`, for the same reason: the
 * null object is a value, not a branch at every call site.
 */
export const silentStatusLine: StatusLine = {
  begin: (): void => {},
  update: (): void => {},
  end: (): void => {},
  clear: (): void => {},
};

export function createStatusLine(options: StatusOptions = {}): StatusLine {
  const write = options.write ?? ((text: string): void => void process.stderr.write(text));
  const interactive = options.interactive ?? process.stderr.isTTY === true;
  const colour = (options.colour ?? interactive) && process.env.NO_COLOR === undefined;
  const dim = (text: string): string => (colour ? `${DIM}${text}${RESET}` : text);

  let label: string | null = null;
  let startedAt = 0;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const draw = (): void => {
    if (label === null) return;
    frame = (frame + 1) % FRAMES.length;
    write(`${CLEAR_LINE}${FRAMES[frame]} ${label} ${dim(`· ${formatElapsed(now() - startedAt)}`)}`);
  };

  const stopTimer = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  const close = (trailer: string | null): void => {
    if (label === null) return;
    const elapsed = formatElapsed(now() - startedAt);
    stopTimer();
    if (interactive) write(CLEAR_LINE);
    if (trailer !== null) write(`${trailer} ${dim(`· ${elapsed}`)}\n`);
    label = null;
  };

  return {
    begin(next: string): void {
      close(null);
      label = next;
      startedAt = now();
      frame = 0;
      if (!interactive) {
        // No cursor to move, so a redraw would stack a hundred lines per minute.
        // One line per phase is the honest degradation: you lose the clock, you
        // keep the narrative, and a piped log stays readable.
        write(`${next}\n`);
        return;
      }
      draw();
      // `unref` so a forgotten status line can never hold the process open. A
      // CLI that will not exit is a worse bug than a missing spinner.
      timer = setInterval(draw, TICK_MS);
      timer.unref?.();
    },

    update(next: string): void {
      if (label === null) return;
      label = next;
      if (interactive) draw();
    },

    end(summary: string): void {
      close(summary);
    },

    clear(): void {
      close(null);
    },
  };
}

/**
 * Isolated so a test can freeze it, and so the one impure call in this file is
 * named rather than sprinkled. `apps/` is outside the determinism boundary rule
 * — that covers `domain/`, `engine/` and `wire/` — so this needs no `Clock`.
 */
const now = (): number => Date.now();
