import type {
  Elicitation,
  Generated,
  GenerationMethod,
  Operation,
  StructuredGenerator,
  Usage,
} from '../../domain/index.ts';

/**
 * Records what every generation call actually did.
 *
 * **This exists because `Turn` cannot answer the question the evals ask.** A
 * `Turn` stores `usage`, which is tokens and cost — but `Generated.method` and
 * `Generated.repairs` are per-*call* facts that never reach it, and "was this
 * constrained or prompted, and how much repairing did it need?" is precisely
 * what decides whether prompted generation is viable. Threading two fields
 * through `Usage`, `Turn`, the commit and both storage adapters to answer a
 * question only an eval asks would be paying a schema cost forever for a
 * measurement taken occasionally.
 *
 * A decorator instead, for the same three reasons `withValidationRetry` is one:
 * written once for every provider, testable against the fake with no network,
 * and it keeps the provider adapters to their one job.
 *
 * **Order matters when composing.** Put this *outside* the retry decorator to
 * count one entry per logical call with the retries already folded in, or
 * *inside* it to see each attempt separately. The evals want the former; a
 * debugging session wants the latter. Neither is the default, so the caller
 * chooses by where they wrap.
 */

export interface MeteredCall {
  readonly operation: Operation;
  readonly method: GenerationMethod;
  /** What the ladder had to do to make the output parse. Empty on a clean call. */
  readonly repairs: readonly string[];
  readonly usage: Usage;
}

export interface CallMeter {
  readonly calls: readonly MeteredCall[];
  record(call: MeteredCall): void;
  reset(): void;
}

export function createCallMeter(): CallMeter {
  const calls: MeteredCall[] = [];
  return {
    calls,
    record(call) {
      calls.push(call);
    },
    reset() {
      calls.length = 0;
    },
  };
}

/**
 * Wraps a generator so every successful call is recorded.
 *
 * **Failures are deliberately not recorded here.** A call that throws produced
 * no `method` and no `repairs` to record, and its usage is already folded into
 * the successful attempt by `withValidationRetry` — counting it again would
 * double-bill a recovered call. The retry decorator's log is where failures are
 * observable; this is where outcomes are.
 */
export function withMetering(inner: StructuredGenerator, meter: CallMeter): StructuredGenerator {
  return {
    async generate<T>(elicitation: Elicitation<T>): Promise<Generated<T>> {
      const result = await inner.generate(elicitation);
      meter.record({
        operation: elicitation.operation,
        method: result.method,
        repairs: result.repairs,
        usage: result.usage,
      });
      return result;
    },
  };
}
