import { describe, expect, it } from 'vitest';
import { streamingLogger } from './logging.ts';

/**
 * `--verbose` used to swap in `recordingLogger()`, whose entries nothing in this
 * app ever read. These tests exist so the flag cannot quietly become inert
 * again: a logger that writes nowhere passes every one of them only if the
 * writer is never called, which the first test forbids.
 */
describe('streamingLogger', () => {
  const capture = () => {
    const lines: string[] = [];
    return { lines, logger: streamingLogger((line) => lines.push(line)) };
  };

  it('writes when something is logged', () => {
    const { lines, logger } = capture();
    logger.debug('generation method chosen', { operation: 'assess', method: 'tool' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[debug] generation method chosen');
    expect(lines[0]).toContain('operation=assess');
    expect(lines[0]).toContain('method=tool');
  });

  it('keeps one event on one line', () => {
    // A log that wraps across a screen is one nobody reads to the end.
    const { lines, logger } = capture();
    logger.warn('model output failed schema validation', { attempt: 2, operation: 'analyze' });

    expect(lines[0]?.trimEnd().split('\n')).toHaveLength(1);
  });

  it('renders Zod issues as paths rather than a screenful of JSON', () => {
    // The issues array is the most useful field here and the worst to dump raw.
    // The paths name the field the model got wrong, which is the reason to look.
    const { lines, logger } = capture();
    logger.warn('model output failed schema validation', {
      issues: [
        { path: ['ops', 3, 'kind'], message: 'Invalid' },
        { path: ['ops', 4, 'statement'], message: 'Invalid' },
      ],
    });

    expect(lines[0]).toContain('issues=ops.3.kind, ops.4.statement');
    expect(lines[0]).not.toContain('"message"');
  });

  it('carries every level', () => {
    const { lines, logger } = capture();
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(lines.map((line) => line.trim())).toEqual([
      '[debug] d',
      '[info] i',
      '[warn] w',
      '[error] e',
    ]);
  });

  describe('the LOG_LEVEL floor', () => {
    const emitAll = (minimum: Parameters<typeof streamingLogger>[1]): string[] => {
      const lines: string[] = [];
      const logger = streamingLogger((line) => void lines.push(line), minimum);
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      return lines.map((line) => line.trim());
    };

    it('drops everything below the floor', () => {
      // The default: `LOG_LEVEL=info` keeps the retry narrative and hides the
      // one-line-per-call method choice, which is what `--verbose` is for.
      expect(emitAll('info')).toEqual(['[info] i', '[warn] w', '[error] e']);
      expect(emitAll('warn')).toEqual(['[warn] w', '[error] e']);
    });

    it('keeps everything at debug, which is what --verbose selects', () => {
      expect(emitAll('debug')).toHaveLength(4);
    });

    it('silences everything at fatal rather than silencing nothing', () => {
      // `fatal` is in the config enum and no `Logger` method emits one. Were it
      // missing from the level list, `indexOf` would return -1 and every message
      // would clear a floor of -1 — the setting would read as "log everything".
      expect(emitAll('fatal')).toEqual([]);
    });
  });
});
