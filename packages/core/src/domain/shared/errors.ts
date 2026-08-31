import type { Usage } from './usage.ts';

/**
 * Domain errors.
 *
 * `CapabilityError` matters most for the provider-agnostic constraint: adapters
 * catch whatever their vendor SDK throws and re-throw this, so no vendor error
 * type ever reaches the engine. An `AI_APICallError` crossing that boundary
 * would be as much of a leak as importing the SDK directly.
 */

export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A delta referenced an entity that does not exist in the current understanding. */
export class UnknownReferenceError extends DomainError {
  readonly collection: string;
  readonly references: readonly string[];

  constructor(collection: string, references: readonly string[]) {
    super(
      'UNKNOWN_REFERENCE',
      `Delta references ${references.length} unknown ${collection} id(s): ${references.join(', ')}`,
    );
    this.collection = collection;
    this.references = references;
  }
}

/**
 * The IdGenerator produced an id that is already in use.
 *
 * Distinct from `UnknownReferenceError`: that one means the model referenced
 * something that does not exist, this one means the *infrastructure* handed back
 * a colliding id. Different cause, different fix.
 */
export class DuplicateIdError extends DomainError {
  readonly collection: string;
  readonly id: string;

  constructor(collection: string, id: string) {
    super(
      'DUPLICATE_ID',
      `IdGenerator produced "${id}", which is already used by another ${collection}.`,
    );
    this.collection = collection;
    this.id = id;
  }
}

/**
 * A promoted or added Decision named nothing that settled it.
 *
 * Distinct from `UnknownReferenceError`, which means a reference pointed at
 * something absent. This one means there was no reference at all — the model
 * asserted a decision without saying what made it one. Every Decision must trace
 * back to an Answer or a Source, because that trail is the only thing separating
 * a decision from an opinion.
 */
export class UnsettledDecisionError extends DomainError {
  readonly statement: string;
  readonly promotedFrom: string | null;

  constructor(statement: string, promotedFrom: string | null) {
    super(
      'UNSETTLED_DECISION',
      `A decision must name what settled it — an answered question or a cited source. ` +
        `Neither was supplied for ${promotedFrom === null ? 'a new decision' : `the promotion of ${promotedFrom}`}: "${statement}".`,
    );
    this.statement = statement;
    this.promotedFrom = promotedFrom;
  }
}

export class InvalidAnswerError extends DomainError {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super('INVALID_ANSWER', message);
    this.reason = reason;
  }
}

export class SessionStateError extends DomainError {
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string) {
    super('INVALID_SESSION_TRANSITION', `A session cannot move from "${from}" to "${to}".`);
    this.from = from;
    this.to = to;
  }
}

/** Thrown by adapters so vendor-specific error types never cross into the engine. */
export class CapabilityError extends DomainError {
  readonly capability: string;
  readonly provider: string;
  readonly retryable: boolean;
  /**
   * What the failed attempt already cost, when the provider reported it.
   *
   * A failed call is billed like any other, so dropping this makes a retried
   * turn under-report its spend — and `retryable: true` exists precisely so the
   * caller tries again. Carrying it lets `withValidationRetry` fold the wasted
   * attempts into the usage it returns.
   */
  readonly usage: Usage | null;

  constructor(
    capability: string,
    provider: string,
    message: string,
    options?: { retryable?: boolean; cause?: unknown; usage?: Usage },
  ) {
    super('CAPABILITY_FAILED', `${capability} via "${provider}" failed: ${message}`, {
      cause: options?.cause,
    });
    this.capability = capability;
    this.provider = provider;
    this.retryable = options?.retryable ?? false;
    this.usage = options?.usage ?? null;
  }
}
