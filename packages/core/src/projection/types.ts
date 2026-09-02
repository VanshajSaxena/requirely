import type { Answer, Question, Session, Source, UnderstandingRevision } from '../domain/index.ts';

/**
 * Everything a projection is allowed to see.
 *
 * All of it is **passed in rather than fetched**. Source labels, questions and
 * answers live in repositories, not in the `Understanding`, so a projection that
 * wanted them could either take a repository — becoming the first thing in this
 * layer able to fail, and impossible to snapshot-test — or receive them. It
 * receives them.
 *
 * The result: every projection is a pure function of its input. Given the same
 * revision it renders the same bytes, forever, with no model call and no I/O.
 * That is invariant #1 stated as a type.
 */
export interface ProjectionInput {
  readonly session: Session;
  readonly revision: UnderstandingRevision;
  /** For the Sources appendix, and for naming a source that settled a decision. */
  readonly sources: readonly Source[];
  /**
   * Every question asked in this session, and every answer given.
   *
   * **Required, deliberately not defaulted to `[]`.** Phase 6 recorded the gap
   * these close: *"`whatWasAsked` shows resolutions but not the question text,
   * because Question records live in the inquiry repository which projections
   * don't receive."* Defaulting them would let a caller forget and get a quietly
   * thinner document; requiring them makes forgetting a compile error, which is
   * the only version of that message anyone reads.
   *
   * They are what turn `Decision.settledBy` from an id into *"we chose SSO; we
   * considered and rejected magic links because every login would need a working
   * inbox"* — see `deliberation.ts`.
   */
  readonly questions: readonly Question[];
  readonly answers: readonly Answer[];
}

export type Projection = (input: ProjectionInput) => string;
