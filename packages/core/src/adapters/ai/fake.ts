import {
  CapabilityError,
  type Effort,
  type Elicitation,
  type Generated,
  type GenerationMethod,
  type Operation,
  type StructuredGenerator,
  sumUsage,
  Usage,
  type UsageTotals,
} from '../../domain/index.ts';

/**
 * A StructuredGenerator that returns scripted responses instead of calling a model.
 *
 * Two properties make this more than a stub:
 *
 * 1. **It validates every scripted value against the requested schema.** A
 *    fixture that drifts from the domain fails here exactly as a real model's
 *    malformed output would. A fake that skips validation tests only itself.
 * 2. **It estimates usage from payload size.** Token counts are proportional to
 *    what was actually sent, so cost-shaped assertions — "merged sends fewer
 *    tokens than separate" — are meaningful without touching a provider.
 *
 * Scripts are keyed by `operation` rather than call order, so a test reads as
 * "here is what analyze returns" instead of "here is response number three",
 * and reordering engine steps does not silently reassign fixtures.
 */

export type FakeScript = Partial<Record<Operation, readonly unknown[]>>;

export interface RecordedCall {
  readonly operation: Operation;
  readonly instructions: string;
  readonly input: string;
  readonly effort: Effort | undefined;
  /** Recorded so a test can assert no call goes out without a spend ceiling. */
  readonly maxOutputTokens: number | undefined;
  /** How many examples the engine attached, if any — see `FakeOptions.method`. */
  readonly examples: number;
}

export interface FakeOptions {
  /**
   * Which method to claim on `Generated.method`.
   *
   * A fake cannot *be* constrained — it returns whatever the script says — so
   * this is a label, and labelling it honestly matters: a test asserting "the
   * prompted path is exercised" must not be satisfied by a fake that always says
   * `constrained`. Scripts are still validated against the real schema either
   * way, which is the part that actually catches drift.
   */
  readonly method?: GenerationMethod;
}

export interface FakeStructuredGenerator extends StructuredGenerator {
  readonly calls: readonly RecordedCall[];
  callsFor(operation: Operation): readonly RecordedCall[];
  totals(): UsageTotals;
  /** Fails if any scripted response went unused — usually a test asserting the wrong flow. */
  assertScriptDrained(): void;
}

/** Rough proxy: ~4 characters per token. Wrong in absolute terms, useful for comparison. */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export function fakeStructuredGenerator(
  script: FakeScript = {},
  options: FakeOptions = {},
): FakeStructuredGenerator {
  const method = options.method ?? 'constrained';
  const queues = new Map<Operation, unknown[]>(
    Object.entries(script).map(([operation, values]) => [
      operation as Operation,
      [...(values ?? [])],
    ]),
  );
  const calls: RecordedCall[] = [];
  const usages: Usage[] = [];

  return {
    calls,

    async generate<T>(elicitation: Elicitation<T>): Promise<Generated<T>> {
      const request = elicitation;
      calls.push({
        operation: request.operation,
        instructions: request.instructions,
        input: request.input,
        effort: request.effort,
        maxOutputTokens: request.maxOutputTokens,
        examples: request.examples?.length ?? 0,
      });

      const queue = queues.get(request.operation);
      if (queue === undefined || queue.length === 0) {
        throw new CapabilityError(
          request.operation,
          'fake',
          `no scripted response left (call ${calls.filter((c) => c.operation === request.operation).length} for this operation)`,
        );
      }

      const scripted = queue.shift();
      const parsed = elicitation.schema.safeParse(scripted);
      if (!parsed.success) {
        // `retryable: true` is the contract `withValidationRetry` keys on. The
        // fake reports schema disagreement exactly as a real provider does, so
        // the retry decorator can be tested against it with no network.
        //
        // It reports the failed attempt's `usage` for the same reason: a real
        // provider bills for output that fails validation, and a fake that
        // returned it for free would let a cost-accounting bug pass every test.
        throw new CapabilityError(
          request.operation,
          'fake',
          `scripted response does not satisfy the schema: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
            .join('; ')}`,
          {
            retryable: true,
            usage: Usage.parse({
              operation: request.operation,
              provider: 'fake',
              model: 'fake-1',
              inputTokens: estimateTokens(request.instructions) + estimateTokens(request.input),
              outputTokens: estimateTokens(JSON.stringify(scripted)),
              costMinorUnits: 0,
            }),
          },
        );
      }

      const usage = Usage.parse({
        operation: request.operation,
        provider: 'fake',
        model: 'fake-1',
        inputTokens: estimateTokens(request.instructions) + estimateTokens(request.input),
        outputTokens: estimateTokens(JSON.stringify(scripted)),
        costMinorUnits: 0,
      });
      usages.push(usage);

      return { value: parsed.data, usage, method, raw: null, repairs: [] };
    },

    callsFor(operation: Operation): readonly RecordedCall[] {
      return calls.filter((call) => call.operation === operation);
    },

    totals(): UsageTotals {
      return sumUsage(usages);
    },

    assertScriptDrained(): void {
      const leftovers = [...queues.entries()]
        .filter(([, queue]) => queue.length > 0)
        .map(([operation, queue]) => `${operation}: ${queue.length} unused`);
      if (leftovers.length > 0) {
        throw new Error(`Fake script not drained — ${leftovers.join(', ')}`);
      }
    },
  };
}
