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

  constructor(
    capability: string,
    provider: string,
    message: string,
    options?: { retryable?: boolean; cause?: unknown },
  ) {
    super('CAPABILITY_FAILED', `${capability} via "${provider}" failed: ${message}`, {
      cause: options?.cause,
    });
    this.capability = capability;
    this.provider = provider;
    this.retryable = options?.retryable ?? false;
  }
}
