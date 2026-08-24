import { v7 as uuidv7 } from 'uuid';
import { type EntityKind, ID_PREFIX, type IdGenerator } from '../../domain/index.ts';

/**
 * UUIDv7 rather than v4: the first 48 bits are a millisecond timestamp, so IDs
 * sort chronologically. For append-only tables (revisions, turns, sources) that
 * means insertion order matches index order, which keeps B-tree writes local
 * instead of scattering them — and it makes a raw `ORDER BY id` meaningful when
 * debugging.
 *
 * The prefix is for humans and for models: `req_01937...` is legible in a log
 * line and in a context window where a bare UUID is noise.
 */
export function uuidIdGenerator(): IdGenerator {
  return {
    next: (kind: EntityKind): string => `${ID_PREFIX[kind]}-${uuidv7()}`,
  };
}
