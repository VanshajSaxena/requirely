import type { Answer } from '../inquiry/answer.ts';
import type { Question } from '../inquiry/question.ts';
import type { Session } from '../session/session.ts';
import type { AnswerId, QuestionId, RevisionId, SessionId, SourceId } from '../shared/ids.ts';
import type { Source } from '../source/source.ts';
import type { TurnCommit } from '../turn/commit.ts';
import type { Turn } from '../turn/turn.ts';
import type { UnderstandingRevision } from '../understanding/understanding.ts';

/**
 * Persistence seams.
 *
 * Note what is *missing* here: there is no way to append a revision, add a
 * question, or record an answer on its own. Every write a turn produces travels
 * together in a `TurnCommit` through `TurnCommitter`, which makes "a revision
 * only exists because some turn produced it" an invariant the types enforce
 * rather than a convention someone has to remember.
 *
 * That leaves two of these read-only, which is why they look thin.
 */

export interface SessionRepository {
  create(session: Session): Promise<void>;
  findById(id: SessionId): Promise<Session | null>;
  /** For changes made outside a turn — choosing an output target, renaming. */
  save(session: Session): Promise<void>;
  listTurns(sessionId: SessionId): Promise<readonly Turn[]>;
  /**
   * Most recently touched sessions first.
   *
   * Exists because there was no way to *find* a session: a CLI that printed an
   * id on `new` and then required the user to keep it would be storing state in
   * the user's scrollback. The alternative considered and rejected was a
   * `~/.requirely/last-session` file, which puts durable state outside the
   * Understanding — the thing invariant #1 forbids.
   *
   * Ordered by `updatedAt`, not `createdAt`: "what was I working on" is a
   * question about activity, and a long-running session would otherwise sink
   * below sessions started after it and abandoned.
   */
  listRecent(limit: number): Promise<readonly Session[]>;
}

/**
 * Ingestion happens outside a turn, so sources keep their own writes.
 *
 * `findById` takes a session because a source id is only unique *within* a
 * session (`src-1`, `src-2`). That is deliberate: `provenance.sourceId` is the
 * one table primary key a model has to emit, and a 40-character UUID on every
 * requirement it adds was the single largest transcription risk in the system.
 */
export interface SourceRepository {
  add(source: Source): Promise<void>;
  save(source: Source): Promise<void>;
  findById(sessionId: SessionId, id: SourceId): Promise<Source | null>;
  listBySession(sessionId: SessionId): Promise<readonly Source[]>;
  /**
   * Deletes a source. The **only** legitimate caller is ingestion cleaning up a
   * `pending` row whose transcription failed, so that a failure leaves no
   * durable trace.
   *
   * This weakens "sources are append-only", which ordinal assignment relies on:
   * after a deletion, `listBySession().length + 1` reissues the same ordinal.
   * That reuse is safe for exactly one reason — a `pending` source has no text,
   * so `isAnalyzable()` is false, so it can never be cited in `provenance` and
   * never reaches a turn. Nothing can be holding the id being reused.
   *
   * `engine/loop.ts` enforces the premise by skipping non-analyzable sources, so
   * this is a checked property rather than a comment asking to be believed.
   */
  remove(sessionId: SessionId, id: SourceId): Promise<void>;
}

/** Read-only. Revisions are append-only and appended only by a committed turn. */
export interface UnderstandingRepository {
  findById(id: RevisionId): Promise<UnderstandingRevision | null>;
  findLatest(sessionId: SessionId): Promise<UnderstandingRevision | null>;
  listBySession(sessionId: SessionId): Promise<readonly UnderstandingRevision[]>;
}

/** Read-only. Questions and answers arrive through a turn commit. */
export interface InquiryRepository {
  findQuestion(id: QuestionId): Promise<Question | null>;
  /**
   * Every question ever asked in this session, answered or not.
   *
   * Distinct from `listUnansweredQuestions`, which exists to drive the *next*
   * prompt and therefore excludes exactly the set a projection needs: an
   * answered question is what a Decision's audit trail is made of. "We chose
   * SSO; we considered and rejected magic links because …" is a join from
   * `Decision.settledBy` through here.
   */
  listQuestions(sessionId: SessionId): Promise<readonly Question[]>;
  /**
   * Questions with no answer row at all.
   *
   * A *deferred* question has one, so it is excluded here — it has been
   * responded to, just not answered. That is deliberate: re-surfacing it every
   * turn would be nagging rather than deferring, and the loop would ask the same
   * thing until the budget ran out.
   */
  listUnansweredQuestions(sessionId: SessionId): Promise<readonly Question[]>;
  /** Questions the user explicitly parked, for `requirely answer --deferred`. */
  listDeferredQuestions(sessionId: SessionId): Promise<readonly Question[]>;
  findAnswer(id: AnswerId): Promise<Answer | null>;
  listAnswers(sessionId: SessionId): Promise<readonly Answer[]>;
}

/**
 * Writes an entire turn atomically.
 *
 * Implementations must apply all of a commit or none of it. The engine has
 * already done every slow, failure-prone thing by the time this is called, so
 * the transaction here should be short.
 */
export interface TurnCommitter {
  commit(commit: TurnCommit): Promise<void>;
}
