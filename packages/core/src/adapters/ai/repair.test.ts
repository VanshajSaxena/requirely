import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractJson, repairToValid, stripTrailingCommas, unwrapEnvelope } from './repair.ts';

/**
 * The ladder that makes `prompted` generation viable. Pure, so every rung is
 * tested in isolation — which matters because the failure mode of an
 * over-eager repair is a quiet wrong answer, not an error.
 */

const Shape = z.object({ value: z.string().min(1) });
const accepts = (candidate: unknown) => Shape.safeParse(candidate).success;

describe('extractJson', () => {
  it('returns clean JSON unchanged', () => {
    expect(extractJson('{"value":"ok"}')).toBe('{"value":"ok"}');
  });

  it('unwraps a fenced code block', () => {
    expect(extractJson('```json\n{"value":"ok"}\n```')).toBe('{"value":"ok"}');
    expect(extractJson('```\n{"value":"ok"}\n```')).toBe('{"value":"ok"}');
  });

  it('discards prose on both sides', () => {
    const text = 'Sure! Here is the delta:\n{"value":"ok"}\nLet me know if you need changes.';
    expect(extractJson(text)).toBe('{"value":"ok"}');
  });

  it('scans for a balanced value rather than the first brace', () => {
    // Prose routinely contains a brace. A regex from the first `{` to the last
    // `}` would grab the prose too and then fail to parse.
    const text = 'Use {curly} braces here. Answer:\n{"value":"ok","nested":{"a":1}}';
    expect(extractJson(text)).toBe('{"value":"ok","nested":{"a":1}}');
  });

  it('ignores braces inside strings', () => {
    expect(extractJson('{"value":"a } trap"}')).toBe('{"value":"a } trap"}');
  });

  it('ignores an escaped quote when tracking string boundaries', () => {
    expect(extractJson('{"value":"say \\" then }"}')).toBe('{"value":"say \\" then }"}');
  });

  it('handles a top-level array', () => {
    expect(extractJson('here: [1,2,3] done')).toBe('[1,2,3]');
  });

  it('refuses to repair truncation', () => {
    // Appending the missing closers would turn a cut-off list of requirements
    // into a shorter list that looks complete. A retry is the honest outcome.
    expect(extractJson('{"value":"ok","items":[1,2')).toBeNull();
  });

  it('returns null when there is no JSON at all', () => {
    expect(extractJson('I am not able to help with that.')).toBeNull();
  });
});

describe('stripTrailingCommas', () => {
  it('removes them before a closing brace or bracket', () => {
    expect(stripTrailingCommas('{"a":1,}')).toBe('{"a":1}');
    expect(stripTrailingCommas('[1,2,]')).toBe('[1,2]');
    expect(stripTrailingCommas('{"a":[1,2,],}')).toBe('{"a":[1,2]}');
  });

  it('leaves legitimate commas alone', () => {
    expect(stripTrailingCommas('{"a":1,"b":2}')).toBe('{"a":1,"b":2}');
  });

  it('never touches a comma inside a string', () => {
    // The whole reason this walks characters instead of using a regex: a
    // requirement statement ending in ", " is entirely normal.
    const text = '{"value":"first, "}';
    expect(stripTrailingCommas(text)).toBe(text);
  });
});

describe('unwrapEnvelope', () => {
  it('unwraps exactly one key', () => {
    expect(unwrapEnvelope({ delta: { value: 'ok' } })).toEqual({ value: 'ok' });
  });

  it('refuses when there is a choice to get wrong', () => {
    expect(unwrapEnvelope({ a: { x: 1 }, b: { y: 2 } })).toBeNull();
  });

  it('refuses a scalar payload, which is not an envelope', () => {
    expect(unwrapEnvelope({ value: 'ok' })).toBeNull();
  });

  it('refuses arrays and non-objects', () => {
    expect(unwrapEnvelope([{ a: 1 }])).toBeNull();
    expect(unwrapEnvelope('text')).toBeNull();
  });
});

describe('repairToValid — the ladder as a whole', () => {
  it('reports no repairs when the output was already clean', () => {
    const result = repairToValid('{"value":"ok"}', accepts);
    expect(result.ok).toBe(true);
    expect(result.repairs).toEqual([]);
  });

  it('records each rung it had to use', () => {
    const result = repairToValid('Here you go:\n```json\n{"value":"ok",}\n```', accepts);
    expect(result.ok).toBe(true);
    expect(result.repairs).toEqual([
      'extracted the JSON value from surrounding text',
      'removed trailing commas',
    ]);
  });

  it('unwraps an envelope only after the outer value failed validation', () => {
    const result = repairToValid('{"delta":{"value":"ok"}}', accepts);
    expect(result.ok).toBe(true);
    expect(result.repairs).toEqual(['unwrapped a single-key envelope']);
  });

  it('does not unwrap when the outer value already validates', () => {
    // A schema that accepts the envelope itself must win. Unwrapping first would
    // silently discard the outer object whenever it happened to have one key.
    const Envelope = z.object({ delta: z.object({ value: z.string() }) });
    const result = repairToValid('{"delta":{"value":"ok"}}', (c) => Envelope.safeParse(c).success);
    expect(result.repairs).toEqual([]);
  });

  it('fails rather than guessing when nothing on the ladder works', () => {
    expect(repairToValid('{"value":123}', accepts).ok).toBe(false);
    expect(repairToValid('I cannot do that.', accepts).ok).toBe(false);
  });
});
