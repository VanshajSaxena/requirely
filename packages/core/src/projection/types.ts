import type { Session, Source, UnderstandingRevision } from '../domain/index.ts';

/**
 * Everything a projection is allowed to see.
 *
 * `sources` is **passed in rather than fetched**. Source labels live in the
 * repository, not in the `Understanding`, so a projection that wanted them could
 * either take a repository — becoming the first thing in this layer able to fail
 * and impossible to snapshot-test — or receive them. It receives them.
 *
 * The result: every projection is a pure function of its input. Given the same
 * revision it renders the same bytes, forever, with no model call and no I/O.
 * That is invariant #1 stated as a type.
 */
export interface ProjectionInput {
  readonly session: Session;
  readonly revision: UnderstandingRevision;
  readonly sources: readonly Source[];
}

export type Projection = (input: ProjectionInput) => string;
