import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallRequest, CallResponse } from '@requirely/core/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRunLog } from './runlog.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'requirely-runlog-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const request = (over: Partial<CallRequest> = {}): CallRequest => ({
  operation: 'analyze',
  provider: 'openai',
  model: 'gpt-5.6-luna',
  method: 'constrained',
  effort: 'high',
  maxOutputTokens: 4000,
  instructions: 'system prompt',
  input: 'the brief',
  schema: { type: 'object' },
  providerOptions: {},
  ...over,
});

const response: CallResponse = {
  value: { ops: [] },
  raw: null,
  usage: {
    operation: 'analyze',
    provider: 'openai',
    model: 'gpt-5.6-luna',
    inputTokens: 100,
    outputTokens: 200,
    costMinorUnits: 3,
  },
  repairs: [],
  finishReason: 'stop',
  warnings: [],
  providerMetadata: null,
};

const linesOf = (runDir: string): unknown[] =>
  readFileSync(join(runDir, 'calls.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown);

describe('createRunLog', () => {
  it('writes nothing at all until an event arrives', () => {
    // The behaviour that stopped one `pnpm verify` leaving 11 empty
    // directories behind. Every command builds a runtime; only a turn against
    // a real provider has anything to record.
    const log = createRunLog({ dir });
    expect(readdirSync(dir)).toEqual([]);
    expect(log.recorded).toBe(false);

    log.observe({ kind: 'call.start', callId: 'call-1', request: request() });
    expect(readdirSync(dir)).toHaveLength(1);
    expect(log.recorded).toBe(true);
  });

  it('does not write a turn summary for a run that made no call', () => {
    const log = createRunLog({ dir });
    log.finish({ status: 'sufficient' });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('records one parseable JSON object per line', () => {
    const log = createRunLog({ dir });
    log.observe({ kind: 'call.start', callId: 'call-1', request: request() });
    log.observe({ kind: 'call.end', callId: 'call-1', response });

    const runDir = join(dir, readdirSync(dir)[0] as string);
    const records = linesOf(runDir) as { kind: string; elapsedMs: number | null }[];

    expect(records.map((record) => record.kind)).toEqual(['call.start', 'call.end']);
    // Derived by the sink from arrival times, because `CallEvent` carries no
    // clock — which is what keeps `Date.now()` out of core entirely.
    expect(records[0]?.elapsedMs).toBeNull();
    expect(records[1]?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps the full prompt and the full input, which is the whole point', () => {
    const log = createRunLog({ dir });
    log.observe({
      kind: 'call.start',
      callId: 'call-1',
      request: request({ instructions: 'THE-SYSTEM-PROMPT', input: 'THE-INPUT' }),
    });

    const runDir = join(dir, readdirSync(dir)[0] as string);
    const body = readFileSync(join(runDir, 'calls.jsonl'), 'utf8');
    expect(body).toContain('THE-SYSTEM-PROMPT');
    expect(body).toContain('THE-INPUT');
  });

  it('applies the redactor to a connection string in a failure reason', () => {
    const log = createRunLog({
      dir,
      redact: (text) => text.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]*@/gi, '$1:***@'),
    });
    log.observe({
      kind: 'call.fail',
      callId: 'call-1',
      retryable: false,
      reason: 'could not reach postgres://requirely:hunter2@localhost:5433/requirely',
      usage: null,
    });

    const runDir = join(dir, readdirSync(dir)[0] as string);
    const body = readFileSync(join(runDir, 'calls.jsonl'), 'utf8');
    expect(body).not.toContain('hunter2');
    expect(body).toContain('postgres://requirely:***@localhost');
  });

  it('prunes to the most recent runs, oldest first', () => {
    // Pre-seed directories whose names sort the way real ones do: an ISO-8601
    // UTC stamp with `:` and `.` replaced by `-` is still lexicographically
    // ordered, which is the property the prune relies on.
    for (const stamp of ['2026-01-01T00-00-00-000Z', '2026-02-01T00-00-00-000Z']) {
      mkdirSync(join(dir, stamp), { recursive: true });
    }

    const log = createRunLog({ dir, keep: 2 });
    log.observe({ kind: 'call.start', callId: 'call-1', request: request() });

    const remaining = readdirSync(dir).sort();
    expect(remaining).toHaveLength(2);
    // The January one is the oldest and the one that goes.
    expect(remaining).not.toContain('2026-01-01T00-00-00-000Z');
    expect(remaining).toContain('2026-02-01T00-00-00-000Z');
  });

  it('never throws when the directory cannot be created', () => {
    // A full disk or a read-only mount is not a reason to lose a turn that has
    // already been paid for — the log describes the work, it does not gate it.
    //
    // A regular file standing where a directory must go gives ENOTDIR at once.
    // An earlier version of this test pointed at a path under `/proc`, where
    // `mkdirSync(..., { recursive: true })` does not fail — it **hangs**, and
    // took the whole suite with it. Measured, not guessed.
    writeFileSync(join(dir, 'blocker'), 'not a directory', 'utf8');
    const log = createRunLog({ dir: join(dir, 'blocker', 'runs') });

    expect(() => {
      log.observe({ kind: 'call.start', callId: 'call-1', request: request() });
      log.finish({ status: 'sufficient' });
    }).not.toThrow();
  });

  it('names the directory after the session so it can be found later', () => {
    const log = createRunLog({ dir, sessionId: 'ses-01a0' });
    log.observe({ kind: 'call.start', callId: 'call-1', request: request() });
    expect(readdirSync(dir)[0]).toContain('ses-01a0');
    expect(log.path).toContain('ses-01a0');
  });
});
