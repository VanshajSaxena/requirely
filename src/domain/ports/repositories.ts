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
}

/** Ingestion happens outside a turn, so sources keep their own writes. */
export interface SourceRepository {
  add(source: Source): Promise<void>;
  save(source: Source): Promise<void>;
  findById(id: SourceId): Promise<Source | null>;
  listBySession(sessionId: SessionId): Promise<readonly Source[]>;
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
  listUnansweredQuestions(sessionId: SessionId): Promise<readonly Question[]>;
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
