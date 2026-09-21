import { describe, expect, it, vi } from 'vitest';
import { createStatusLine, formatElapsed, silentStatusLine } from './status.ts';

/**
 * The injected writer is the whole point.
 *
 * `logging.test.ts` exists because `--verbose` once swapped in a logger whose
 * output nothing read — a flag that allocated, filled and dropped a list. The
 * same failure is available here: a status line that never calls its writer
 * looks identical to one whose terminal is not a TTY. So every test below
 * asserts on what reached the writer, not on the absence of a crash.
 */

const capture = (): { lines: string[]; write: (text: string) => void } => {
  const lines: string[] = [];
  return { lines, write: (text: string): void => void lines.push(text) };
};

describe('createStatusLine, non-interactive', () => {
  it('emits one plain line per phase and no escape sequences', () => {
    const { lines, write } = capture();
    const status = createStatusLine({ write, interactive: false, colour: false });

    status.begin('Analysing input');
    status.begin('Assessing sufficiency');
    status.clear();

    expect(lines).toEqual(['Analysing input\n', 'Assessing sufficiency\n']);
    // A piped log with cursor movement in it is worse than no log. This is the
    // property that makes `requirely turn <id> 2> run.log` readable.
    expect(lines.join('')).not.toContain('\u001b');
  });

  it('leaves the summary behind when a phase ends', () => {
    const { lines, write } = capture();
    const status = createStatusLine({ write, interactive: false, colour: false });

    status.begin('Analysing input');
    status.end('Analysed');

    expect(lines.at(-1)).toMatch(/^Analysed · \d+s\n$/);
  });
});

describe('createStatusLine, interactive', () => {
  it('draws a frame as soon as a phase begins', () => {
    const { lines, write } = capture();
    const status = createStatusLine({ write, interactive: true, colour: false });

    status.begin('Analysing input');
    status.clear();

    expect(lines[0]).toContain('Analysing input');
    // Redraw in place: return to column 0 and clear to end of line.
    expect(lines[0]).toContain('\r');
  });

  it('clears the line so nothing is left behind', () => {
    const { lines, write } = capture();
    const status = createStatusLine({ write, interactive: true, colour: false });

    status.begin('Analysing input');
    status.clear();

    // The final write must be the clear, or the next thing printed lands on top
    // of a half-drawn spinner frame — which is what `main.ts` guards against by
    // clearing before its single stdout write.
    expect(lines.at(-1)).toBe('\r\u001b[K');
  });

  it('replaces a running phase rather than stacking two', () => {
    const { lines, write } = capture();
    const status = createStatusLine({ write, interactive: true, colour: false });

    status.begin('Analysing input');
    status.begin('Assessing sufficiency');
    status.clear();

    expect(lines.filter((line) => line.includes('Analysing input'))).toHaveLength(1);
  });

  it('ignores an update with no phase running', () => {
    const { lines, write } = capture();
    const status = createStatusLine({ write, interactive: true, colour: false });

    status.update('nothing is running');

    expect(lines).toEqual([]);
  });
});

describe('silentStatusLine', () => {
  it('says nothing at all', () => {
    // The distinction that was a bug: `--quiet` originally set
    // `interactive: false`, which selects the one-line-per-phase *fallback*. A
    // flag meaning "say nothing" printed a line for every phase.
    const { lines, write } = capture();
    const quiet = createStatusLine({ write, interactive: false, colour: false });
    quiet.begin('Analysing input');
    expect(lines).toHaveLength(1);

    // Spying on the real stream is the only honest assertion here: the silent
    // line takes no writer, so "it did not write" has to be observed where it
    // would have written.
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      silentStatusLine.begin('Analysing input');
      silentStatusLine.update('x');
      silentStatusLine.end('Analysed');
      silentStatusLine.clear();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('formatElapsed', () => {
  it('reads as seconds below a minute and m/ss at or above one', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(8_400)).toBe('8s');
    expect(formatElapsed(59_999)).toBe('59s');
    expect(formatElapsed(60_000)).toBe('1m00s');
    // Zero-padded so the column does not jitter while you watch it tick.
    expect(formatElapsed(65_000)).toBe('1m05s');
    expect(formatElapsed(3_723_000)).toBe('62m03s');
  });

  it('does not render a negative duration', () => {
    // A clock that steps backwards mid-phase is rare and real; `-3s` in a
    // status line reads as a bug in the product rather than in the clock.
    expect(formatElapsed(-5_000)).toBe('0s');
  });
});
