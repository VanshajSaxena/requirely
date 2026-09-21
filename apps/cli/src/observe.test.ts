import type { CallEvent, CallRequest, CallResponse } from '@requirely/core/server';
import { describe, expect, it } from 'vitest';
import { createStatusObserver, createTimeline, fanOut, phaseFor } from './observe.ts';
import { createStatusLine } from './status.ts';

/**
 * Renderers over a scripted event sequence.
 *
 * Nothing here touches a provider, and that is the point: the events are pure
 * data — no timestamps, no durations, because the *sink* stamps arrival — so a
 * renderer can be driven from a literal and asserted exactly.
 */

const request = (over: Partial<CallRequest> = {}): CallRequest => ({
  operation: 'analyze',
  provider: 'openai',
  model: 'gpt-5.6-luna',
  method: 'constrained',
  effort: 'high',
  maxOutputTokens: 4000,
  instructions: 'x'.repeat(2048),
  input: 'y'.repeat(512),
  schema: { type: 'object' },
  providerOptions: { openai: { strictJsonSchema: true } },
  ...over,
});

const response = (over: Partial<CallResponse> = {}): CallResponse => ({
  value: { ops: [] },
  raw: null,
  usage: {
    operation: 'analyze',
    provider: 'openai',
    model: 'gpt-5.6-luna',
    inputTokens: 5200,
    outputTokens: 9709,
    costMinorUnits: 127,
  },
  repairs: [],
  finishReason: 'stop',
  warnings: [],
  providerMetadata: null,
  ...over,
});

const capture = (): { text: () => string; write: (line: string) => void } => {
  const parts: string[] = [];
  return {
    text: (): string => parts.join(''),
    write: (line: string): void => void parts.push(line),
  };
};

describe('phaseFor', () => {
  it('names each operation in words someone waiting can read', () => {
    expect(phaseFor('analyze')).toBe('Analysing input');
    expect(phaseFor('assess')).toBe('Assessing sufficiency');
    expect(phaseFor('generate-questions')).toBe('Drafting questions');
    expect(phaseFor('transcribe')).toBe('Transcribing audio');
  });

  it('falls through to the operation name rather than blank or throwing', () => {
    // The merge-extensibility rule: an operation added to core and not yet
    // named here must degrade to something truthful, never break the frame.
    expect(phaseFor('summarise-everything')).toBe('summarise-everything');
  });
});

describe('createTimeline', () => {
  it('reports the request before the answer exists', () => {
    const { text, write } = capture();
    createTimeline({ write, colour: false }).observe({
      kind: 'call.start',
      callId: 'call-1',
      request: request(),
    });

    const out = text();
    expect(out).toContain('● analyze');
    expect(out).toContain('openai/gpt-5.6-luna  constrained');
    // Sizes, not payloads: this line has to stay one line by default.
    expect(out).toContain('instructions 2.0KB');
    expect(out).toContain('input 512B');
    expect(out).toContain('effort high');
  });

  it('reports tokens and cost when the call lands', () => {
    const { text, write } = capture();
    const timeline = createTimeline({ write, colour: false });
    timeline.observe({ kind: 'call.start', callId: 'call-1', request: request() });
    timeline.observe({ kind: 'call.end', callId: 'call-1', response: response() });

    expect(text()).toContain('9,709 out');
    expect(text()).toContain('$1.2700');
    // `stop` is the ordinary ending and would be noise on every single call.
    expect(text()).not.toContain('finish:');
  });

  it('surfaces a finish reason that is not the ordinary one', () => {
    const { text, write } = capture();
    const timeline = createTimeline({ write, colour: false });
    timeline.observe({ kind: 'call.start', callId: 'call-1', request: request() });
    timeline.observe({
      kind: 'call.end',
      callId: 'call-1',
      // The usual cause of a truncated object, and the thing you most want to
      // see without having to pass a flag first.
      response: response({ finishReason: 'length' }),
    });

    expect(text()).toContain('finish: length');
  });

  it('says cost unknown rather than $0.0000 for an unpriced model', () => {
    const { text, write } = capture();
    const timeline = createTimeline({ write, colour: false });
    timeline.observe({ kind: 'call.start', callId: 'call-1', request: request() });
    timeline.observe({
      kind: 'call.end',
      callId: 'call-1',
      response: response({
        usage: { ...response().usage, costMinorUnits: null },
      }),
    });

    expect(text()).toContain('cost unknown');
    expect(text()).not.toContain('$0.0000');
  });

  it('distinguishes a retry from a lost turn', () => {
    const { text, write } = capture();
    const timeline = createTimeline({ write, colour: false });
    timeline.observe({ kind: 'call.start', callId: 'call-1', request: request() });
    timeline.observe({
      kind: 'call.fail',
      callId: 'call-1',
      retryable: true,
      reason: 'schema mismatch',
      usage: null,
    });

    // `retryable` is the whole difference between "wait" and "it is over".
    expect(text()).toContain('retrying: schema mismatch');
    expect(text()).not.toContain('failed:');
  });

  it('prints provider warnings, which the adapter used to discard', () => {
    const { text, write } = capture();
    const timeline = createTimeline({ write, colour: false });
    timeline.observe({ kind: 'call.start', callId: 'call-1', request: request() });
    timeline.observe({
      kind: 'call.end',
      callId: 'call-1',
      response: response({ warnings: ['unsupported setting: seed'] }),
    });

    expect(text()).toContain('unsupported setting: seed');
  });

  it('keeps payloads out unless they were asked for', () => {
    const quiet = capture();
    createTimeline({ write: quiet.write, colour: false }).observe({
      kind: 'call.start',
      callId: 'call-1',
      request: request({ instructions: 'SECRET-INSTRUCTION-BODY' }),
    });
    expect(quiet.text()).not.toContain('SECRET-INSTRUCTION-BODY');

    const loud = capture();
    createTimeline({ write: loud.write, colour: false, payloads: true }).observe({
      kind: 'call.start',
      callId: 'call-1',
      request: request({ instructions: 'SECRET-INSTRUCTION-BODY' }),
    });
    expect(loud.text()).toContain('SECRET-INSTRUCTION-BODY');
  });
});

describe('createStatusObserver', () => {
  it('opens a phase on start and closes it on any ending', () => {
    const lines: string[] = [];
    const status = createStatusLine({
      write: (text: string): void => void lines.push(text),
      interactive: false,
      colour: false,
    });
    const observer = createStatusObserver(status);

    observer.observe({ kind: 'call.start', callId: 'call-1', request: request() });
    observer.observe({ kind: 'call.end', callId: 'call-1', response: response() });
    observer.observe({
      kind: 'call.start',
      callId: 'call-2',
      request: request({ operation: 'assess' }),
    });
    observer.observe({
      kind: 'call.fail',
      callId: 'call-2',
      retryable: false,
      reason: 'boom',
      usage: null,
    });

    expect(lines).toEqual(['Analysing input\n', 'Assessing sufficiency\n']);
  });
});

describe('fanOut', () => {
  it('delivers one event to every sink, in order', () => {
    const seen: string[] = [];
    const sink = (name: string): { observe: (event: CallEvent) => void } => ({
      observe: (event: CallEvent): void => void seen.push(`${name}:${event.kind}`),
    });

    fanOut(sink('a'), sink('b')).observe({
      kind: 'call.start',
      callId: 'call-1',
      request: request(),
    });

    expect(seen).toEqual(['a:call.start', 'b:call.start']);
  });
});
