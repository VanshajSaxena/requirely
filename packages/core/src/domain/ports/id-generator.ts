import type { EntityKind } from '../shared/ids.ts';

/**
 * Identity enters the domain only through here.
 *
 * Returns a plain string deliberately: the caller brands it with the matching ID
 * schema, so the act of parsing is where an untrusted string becomes a trusted
 * identifier of a specific kind.
 */
export interface IdGenerator {
  next(kind: EntityKind): string;
}
