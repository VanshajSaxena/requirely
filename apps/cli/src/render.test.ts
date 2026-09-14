import { describe, expect, it } from 'vitest';
import { describeError } from './render.ts';

/**
 * The backstop for a failure mode that shipped twice.
 *
 * A `ZodError`'s `message` is a JSON dump of its `issues`, and `main.ts` printed
 * `error.message` — so every validation failure that reached the top of the CLI
 * arrived as a bracketed array with no sentence in it. It happened for
 * `--creativity 9`, which was patched at the point of use, and then again for a
 * stored row whose shape had drifted, which was not covered by that patch.
 * Fixing call sites one at a time was the wrong shape of fix.
 */
describe('describeError', () => {
  it('turns Zod issues into lines a person can act on', () => {
    const zodShaped = Object.assign(new Error('[{"code":"invalid_type"}]'), {
      issues: [
        { path: ['options', 0, 'means'], message: 'Invalid input: expected string' },
        { path: ['options', 1, 'means'], message: 'Invalid input: expected string' },
      ],
    });

    const described = describeError(zodShaped);
    expect(described).toContain('Some values did not match');
    expect(described).toContain('options.0.means: Invalid input: expected string');
    // The raw JSON dump must not survive — that is the whole point.
    expect(described).not.toContain('"code"');
  });

  it('caps a long list rather than scrolling the terminal', () => {
    const many = Object.assign(new Error('dump'), {
      issues: Array.from({ length: 9 }, (_, i) => ({ path: ['ops', i], message: 'bad' })),
    });
    expect(describeError(many)).toContain('...and 4 more');
  });

  it('leaves an ordinary error exactly as it is', () => {
    // Most errors here are already sentences written for a user — the Postgres
    // connection message, the unknown-command message. Reformatting those would
    // make this worse, not better.
    expect(describeError(new Error('Could not reach Postgres at …'))).toBe(
      'Could not reach Postgres at …',
    );
  });

  it('survives something that is not an Error at all', () => {
    expect(describeError('a thrown string')).toBe('a thrown string');
    expect(describeError(undefined)).toBe('undefined');
  });

  it('is not fooled by an error whose `issues` is not a list', () => {
    const odd = Object.assign(new Error('real message'), { issues: 'not an array' });
    expect(describeError(odd)).toBe('real message');
  });
});
