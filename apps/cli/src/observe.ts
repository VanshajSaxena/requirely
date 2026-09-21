import type { Usage } from '@requirely/core/domain';
import type { CallEvent, CallObserver, CallRequest } from '@requirely/core/server';
import { formatElapsed, type StatusLine } from './status.ts';

/**
 * Turning call events into something a person watches.
 *
 * Two audiences in one stream, which is why there are two renderers and not one.
 * The **status line** answers *is it alive and what is it doing* and is erased
 * as soon as it is answered. The **timeline** answers *what did that cost* and
 * stays in scrollback. Neither belongs in the other.
 *
 * Everything here writes to **stderr**, because `generate` returns the document
 * on stdout.
 */

const ESC = '\u001b[';
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
const RESET = `${ESC}0m`;

/**
 * Operation → what to call it while it runs.
 *
 * Present tense and plain words: the line is read by someone waiting, not
 * grepped. **An unknown operation falls through to the operation's own name**
 * rather than throwing or rendering blank — the merge-extensibility rule from
 * the reference harness, where an unhandled event kind must leave the phase
 * intact and never break the frame.
 */
const PHASE: Readonly<Record<string, string>> = {
  analyze: 'Analysing input',
  'analyze-and-assess': 'Analysing and assessing',
  assess: 'Assessing sufficiency',
  'generate-questions': 'Drafting questions',
  transcribe: 'Transcribing audio',
  project: 'Rendering document',
};

export const phaseFor = (operation: string): string => PHASE[operation] ?? operation;

export interface TimelineOptions {
  readonly write?: (text: string) => void;
  readonly colour?: boolean;
  /** Adds a preview of what was sent and what came back. `--verbose`. */
  readonly payloads?: boolean;
}

/**
 * The permanent record, one block per call.
 *
 * Deliberately printed at `call.start` *and* `call.end` rather than only at the
 * end. A turn's first call runs for a minute or more; a reader who only ever
 * sees completed calls cannot tell a slow `analyze` from a hung one, and the
 * arrow pair is what makes the request visible before its answer exists.
 */
export function createTimeline(options: TimelineOptions = {}): CallObserver {
  const write = options.write ?? ((text: string): void => void process.stderr.write(text));
  const colour =
    (options.colour ?? process.stderr.isTTY === true) && process.env.NO_COLOR === undefined;
  const dim = (text: string): string => (colour ? `${DIM}${text}${RESET}` : text);
  const bold = (text: string): string => (colour ? `${BOLD}${text}${RESET}` : text);
  const startedAt = new Map<string, number>();

  return {
    observe(event: CallEvent): void {
      if (event.kind === 'call.start') {
        startedAt.set(event.callId, Date.now());
        const { operation, provider, model, method } = event.request;
        write(`\n${bold(`● ${operation}`)}  ${dim(`${provider}/${model}  ${method}`)}\n`);
        write(dim(`  → ${describeRequest(event.request)}\n`));
        if (options.payloads === true)
          write(preview('instructions', event.request.instructions, dim));
        if (options.payloads === true) write(preview('input', event.request.input, dim));
        return;
      }

      const elapsed = takeElapsed(startedAt, event.callId);

      if (event.kind === 'call.fail') {
        // `retryable` is the load-bearing word here: it is the difference
        // between "wait, it is trying again" and "this turn is over".
        const verdict = event.retryable ? 'retrying' : 'failed';
        write(dim(`  ← ${elapsed}  ${verdict}: ${event.reason}\n`));
        return;
      }

      const { usage, repairs, finishReason, warnings } = event.response;
      const parts = [
        elapsed,
        `${usage.outputTokens.toLocaleString()} out`,
        formatCost(usage),
        ...(repairs.length === 0 ? [] : [`${repairs.length} repair(s)`]),
        // Only when it is not the ordinary ending. `length` here is the usual
        // cause of a truncated object, and it is worth seeing without --verbose.
        ...(finishReason === null || finishReason === 'stop' ? [] : [`finish: ${finishReason}`]),
      ];
      write(dim(`  ← ${parts.join('  ')}\n`));
      for (const warning of warnings) write(dim(`    ! ${warning}\n`));
      if (options.payloads === true) {
        write(preview('response', event.response.raw ?? JSON.stringify(event.response.value), dim));
      }
    },
  };
}

/**
 * The status line, driven by the same events.
 *
 * This is the reference harness's rule applied literally: *the phase is
 * presentation state derived from live events, not an event of its own*. Core
 * emits that a call started; what to call it, and whether to animate it, is
 * entirely this layer's business.
 */
export function createStatusObserver(status: StatusLine): CallObserver {
  return {
    observe(event: CallEvent): void {
      if (event.kind === 'call.start') status.begin(phaseFor(event.request.operation));
      else status.clear();
    },
  };
}

/** Sends one event to several sinks. Order is the caller's; failures are not swallowed. */
export function fanOut(...observers: readonly CallObserver[]): CallObserver {
  return {
    observe(event: CallEvent): void {
      for (const observer of observers) observer.observe(event);
    },
  };
}

const describeRequest = (request: CallRequest): string => {
  const sizes = `instructions ${kb(request.instructions)} · input ${kb(request.input)}`;
  return `sent ${sizes} · effort ${request.effort}`;
};

const kb = (text: string): string =>
  text.length < 1024 ? `${text.length}B` : `${(text.length / 1024).toFixed(1)}KB`;

const takeElapsed = (started: Map<string, number>, callId: string): string => {
  const began = started.get(callId);
  if (began === undefined) return '—';
  started.delete(callId);
  return formatElapsed(Date.now() - began);
};

/**
 * `null` cost is not zero cost — the price table does not know every model, and
 * `sumUsage` already keeps the two apart. Saying "cost unknown" is the honest
 * rendering; printing `$0.0000` for an unpriced model would read as free.
 */
const formatCost = (usage: Usage): string =>
  usage.costMinorUnits === null ? 'cost unknown' : `$${(usage.costMinorUnits / 100).toFixed(4)}`;

const PREVIEW_CHARS = 400;

const preview = (label: string, body: string, dim: (text: string) => string): string => {
  const clipped = body.length <= PREVIEW_CHARS ? body : `${body.slice(0, PREVIEW_CHARS)}…`;
  const indented = clipped
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');
  return dim(`    ${label}:\n${indented}\n`);
};
