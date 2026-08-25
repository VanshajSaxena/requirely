import type { z } from 'zod';
import {
  CapabilityError,
  type Generated,
  type GenerationRequest,
  type StructuredGenerator,
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
 * logs `{ operation, attempt, reason }`, and because each attempt is a separate
 * call to the inner generator, a turn whose `usage` array holds more entries
 * than it made operations is visibly a turn that retried — no counter needed.
 *
 * Only *validation* failures retry. A missing API key or a 401 is not going to
 * succeed on the second try; retrying it just spends the user's money slower.
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
    async generate<T>(schema: z.ZodType<T>, request: GenerationRequest): Promise<Generated<T>> {
      let lastReason = 'unknown';

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const augmented: GenerationRequest =
          attempt === 1
            ? request
            : { ...request, input: `${request.input}${correctionNotice(lastReason, attempt - 1)}` };

        try {
          const result = await inner.generate(schema, augmented);
          if (attempt > 1) {
            logger.info('structured generation recovered after retry', {
              operation: request.operation,
              attempts: attempt,
            });
          }
          return result;
        } catch (error) {
          // Anything that is not a schema disagreement is not worth repeating.
          if (!isValidationFailure(error)) throw error;

          lastReason = describe(error);
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
function isValidationFailure(error: unknown): error is CapabilityError {
  return error instanceof CapabilityError && error.retryable;
}

function describe(error: CapabilityError): string {
  return error.message;
}
