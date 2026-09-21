import type { Effort, GenerationMethod } from '../domain/ports/generation.ts';
import type { Operation } from '../domain/shared/operation.ts';
import type { Usage } from '../domain/shared/usage.ts';

/**
 * What a provider call looked like, as it happens.
 *
 * `Logger` answers *what did the code decide* — one line, already formatted,
 * fire and forget. This answers the two questions a logger structurally cannot:
 * **what did we send, what came back**, and **what is happening right now**.
 * Both need paired start/end events with a correlation id and a machine-shaped
 * payload; neither survives being flattened into a message string.
 *
 * A second port rather than more `Logger` fields, for one concrete reason: a
 * live status line has to know when a call *begins* and when it *ends*, and
 * deriving that from log lines means matching on message text. The message then
 * becomes an API that no test guards and a reword silently breaks.
 *
 * ## Events carry facts, not timestamps
 *
 * There is no `at` and no `elapsedMs` anywhere below. **The sink stamps
 * arrival and subtracts.** Two consequences, both deliberate:
 *
 * - `Date.now()` stays out of core. Boundary rule 5 forbids it in `domain/`,
 *   `engine/` and `wire/`, so a timestamp minted here would mean threading the
 *   `Clock` port through a diagnostic — real cost for no gain, since the only
 *   consumer is a renderer that already knows what time it is.
 * - Every event is pure data, so a renderer is snapshot-testable with no clock
 *   to control and no time to freeze.
 *
 * ## Only provider calls
 *
 * Not "everything that happens". Migration, the commit transaction and document
 * rendering are all call sites the *app* owns, and an app does not need an event
 * to talk to itself — it calls its own status line directly. Keeping this port
 * to the one thing an app genuinely cannot see inside is what stops it growing
 * into a general-purpose event bus.
 *
 * `transcribe` is already an `Operation`, so audio ingestion is a call like any
 * other rather than a second concept.
 */

/** Correlates a `call.start` with the `call.end` or `call.fail` that closes it. */
export type CallId = string;

export interface CallRequest {
  readonly operation: Operation;
  readonly provider: string;
  readonly model: string;
  readonly method: GenerationMethod;
  readonly effort: Effort;
  readonly maxOutputTokens: number | null;
  /** The stable, cacheable prefix. */
  readonly instructions: string;
  /** The volatile part — sources, understanding, answers. */
  readonly input: string;
  /**
   * The JSON Schema **as this codebase renders it**, not the bytes on the wire.
   *
   * It is `z.toJSONSchema(schema, { io: 'input' })`, which is the same call
   * `@ai-sdk/provider-utils` makes — but the SDK then wraps the result in
   * `addAdditionalPropertiesToJsonSchema`, so what the provider receives has
   * `additionalProperties: false` stamped through it and this does not. Named
   * and documented rather than quietly presented as the request, because a
   * reader debugging a schema rejection will trust whatever this says.
   */
  readonly schema: unknown;
  /** Vendor-specific options for this method, e.g. `{ openai: { strictJsonSchema: true } }`. */
  readonly providerOptions: Record<string, unknown>;
}

export interface CallResponse {
  /** The parsed, schema-valid value. */
  readonly value: unknown;
  /**
   * The model's literal text — **`null` on `constrained` and `tool`**, where the
   * SDK hands back a parsed object and no text ever existed.
   *
   * Not backfilled by re-serializing `value`. That would read as the model's own
   * output in exactly the place a later reader is trying to find out what the
   * model actually emitted, which is the one place a plausible lie does damage.
   */
  readonly raw: string | null;
  readonly usage: Usage;
  /** Ordered descriptions of each repair rung applied, empty when none were. */
  readonly repairs: readonly string[];
  /** Why generation stopped. `length` here is the usual cause of a truncated object. */
  readonly finishReason: string | null;
  /** Provider warnings — an unsupported setting is reported here, not thrown. */
  readonly warnings: readonly string[];
  readonly providerMetadata: Record<string, unknown> | null;
}

export type CallEvent =
  | { readonly kind: 'call.start'; readonly callId: CallId; readonly request: CallRequest }
  | { readonly kind: 'call.end'; readonly callId: CallId; readonly response: CallResponse }
  | {
      readonly kind: 'call.fail';
      readonly callId: CallId;
      readonly retryable: boolean;
      readonly reason: string;
      /** Billed usage of the failed attempt, when the provider reported any. */
      readonly usage: Usage | null;
    };

export interface CallObserver {
  observe(event: CallEvent): void;
}

/**
 * The default, for the same reason `silentLogger` is: a library that narrates
 * unbidden corrupts its host's output. The CLI and the API each attach their own.
 */
export const silentObserver: CallObserver = {
  observe: (): void => {},
};

/** Collects events in memory. For tests that assert on the sequence. */
export interface RecordingObserver extends CallObserver {
  readonly events: readonly CallEvent[];
}

export function recordingObserver(): RecordingObserver {
  const events: CallEvent[] = [];
  return {
    events,
    observe: (event: CallEvent): void => {
      events.push(event);
    },
  };
}
