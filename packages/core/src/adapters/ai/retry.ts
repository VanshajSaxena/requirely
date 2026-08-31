import {
  CapabilityError,
  type Elicitation,
  type Generated,
  type StructuredGenerator,
  sumUsage,
  Usage,
} from '../../domain/index.ts';
import { type Logger, silentLogger } from '../../observability/logger.ts';

/**
 * Retries a generation whose output failed schema validation, feeding the
 * failure back so the model can correct itself.
 *
 * A **decorator** rather than logic inside each provider adapter, for three
 * reasons: it is written once for every provider present and future; it can be
 * tested against the fake adapter with no network; and it keeps the provider
 * adapters to the one job of translating a vendor's shapes.
 *
 * Observability is the point as much as recovery. Every attempt past the first
 * logs `{ operation, attempt, reason, ... }`, which is how "how often does a real
 * model return output that fails schema validation?" gets a number.
 *
 * **A claim that used to live here was wrong**, and is worth recording because it
 * was wrong in the direction that flatters: it said a retried turn was visible
 * from its `usage` array holding more entries than the turn had operations. It
 * never did. A failed attempt *throws*, so its usage died with the exception and
 * the array kept exactly one entry per operation — the turn silently reported the
 * cost of its last attempt only. The log line was the sole real signal, and the
 * spend was under-reported by a plausible-looking amount.
 *
 * Fixed by carrying `CapabilityError.usage` out of the adapter and folding the
 * wasted attempts into the usage this decorator returns. Pinned by a test, and
 * the fake now bills for failed attempts too — a fake that returned invalid
 * output for free would have let the same bug pass every future test.
 *
 * Only *validation* failures retry. A missing API key or a 401 is not going to
 * succeed on the second try; retrying it just spends the user's money slower.
 *
 * **One reask shape serves all three generation methods**, which is why this
 * stayed a single decorator rather than splitting per method: appending the
 * failure to `input` works whether the schema went as a grammar, as a tool, or
 * as prose, because in every case `input` is what the model reads last. The
 * method-specific work — rendering the contract, extracting JSON, repairing it —
 * happens below this layer and is already exhausted by the time a call fails.
 */

export interface RetryOptions {
  /** Total attempts, including the first. */
  readonly maxAttempts?: number;
  readonly logger?: Logger;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/** Appended to the input so the model sees precisely what it got wrong. */
function correctionNotice(reason: string, attempt: number): string {
  return [
    '',
    '---',
    `Your previous response (attempt ${attempt}) did not satisfy the required schema:`,
    reason,
    'Return the same content, corrected to satisfy the schema exactly.',
    'Do not explain the error; return only the corrected structure.',
  ].join('\n');
}

export function withValidationRetry(
  inner: StructuredGenerator,
  options: RetryOptions = {},
): StructuredGenerator {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const logger = options.logger ?? silentLogger;

  return {
    async generate<T>(request: Elicitation<T>): Promise<Generated<T>> {
      let lastReason = 'unknown';
      // A failed attempt is billed like any other. Collecting it here is the
      // difference between reporting what a recovered call cost and reporting
      // only its last, successful attempt.
      const wasted: Usage[] = [];

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const augmented: Elicitation<T> =
          attempt === 1
            ? request
            : { ...request, input: `${request.input}${correctionNotice(lastReason, attempt - 1)}` };

        try {
          const result = await inner.generate(augmented);
          if (attempt > 1) {
            logger.info('structured generation recovered after retry', {
              operation: request.operation,
              attempts: attempt,
              method: result.method,
              repairs: result.repairs.length,
              wastedTokens: sumUsage(wasted).inputTokens + sumUsage(wasted).outputTokens,
            });
          }
          return wasted.length === 0 ? result : { ...result, usage: fold(result.usage, wasted) };
        } catch (error) {
          // Anything that is not a schema disagreement is not worth repeating.
          if (!isValidationFailure(error)) throw error;

          lastReason = describe(error);
          if (error.usage !== null) wasted.push(error.usage);
          logger.warn('model output failed schema validation', {
            operation: request.operation,
            attempt,
            maxAttempts,
            reason: lastReason,
          });
        }
      }

      throw new CapabilityError(
        request.operation,
        'retry',
        `output failed schema validation on all ${maxAttempts} attempts; last error: ${lastReason}`,
      );
    },
  };
}

/**
 * Provider adapters mark validation failures with `retryable: true`; the fake
 * adapter reports them the same way. That flag is the contract — sniffing error
 * messages would make this quietly stop working the day a vendor reworded one.
 */
/**
 * One `Usage` for the whole call: the successful attempt plus every wasted one.
 *
 * Merged into a single entry rather than appended as extra entries because
 * `Generated.usage` is one value per call, and because operation, provider and
 * model are identical across attempts — only the tokens differ.
 */
function fold(succeeded: Usage, wasted: readonly Usage[]): Usage {
  const total = sumUsage([succeeded, ...wasted]);
  return Usage.parse({
    ...succeeded,
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    costMinorUnits: total.costMinorUnits,
  });
}

function isValidationFailure(error: unknown): error is CapabilityError {
  return error instanceof CapabilityError && error.retryable;
}

function describe(error: CapabilityError): string {
  return error.message;
}
