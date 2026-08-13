import type { Answer } from '../inquiry/answer.ts';
import type { Question } from '../inquiry/question.ts';
import type { Session } from '../session/session.ts';
import type { AnswerId, QuestionId, RevisionId, SessionId, SourceId } from '../shared/ids.ts';
import type { Source } from '../source/source.ts';
import type { Turn } from '../turn/turn.ts';
import type { UnderstandingRevision } from '../understanding/understanding.ts';

/**
 * Persistence seams.
 *
 * Four narrow repositories rather than one fat store, and no transaction port
 * yet: whether the loop needs an explicit unit of work depends on how the real
 * storage adapter turns out, and inventing the abstraction before then would be
 * guessing. Phase 3 decides.
 */

export interface SessionRepository {
  create(session: Session): Promise<void>;
  findById(id: SessionId): Promise<Session | null>;
  save(session: Session): Promise<void>;
  appendTurn(turn: Turn): Promise<void>;
  listTurns(sessionId: SessionId): Promise<readonly Turn[]>;
}

export interface SourceRepository {
  add(source: Source): Promise<void>;
  save(source: Source): Promise<void>;
  findById(id: SourceId): Promise<Source | null>;
  listBySession(sessionId: SessionId): Promise<readonly Source[]>;
}

/** Revisions are append-only; there is deliberately no `update`. */
export interface UnderstandingRepository {
  append(revision: UnderstandingRevision): Promise<void>;
  findById(id: RevisionId): Promise<UnderstandingRevision | null>;
  findLatest(sessionId: SessionId): Promise<UnderstandingRevision | null>;
  listBySession(sessionId: SessionId): Promise<readonly UnderstandingRevision[]>;
}

export interface InquiryRepository {
  addQuestions(questions: readonly Question[]): Promise<void>;
  findQuestion(id: QuestionId): Promise<Question | null>;
  listUnansweredQuestions(sessionId: SessionId): Promise<readonly Question[]>;
  addAnswer(answer: Answer): Promise<void>;
  findAnswer(id: AnswerId): Promise<Answer | null>;
  listAnswers(sessionId: SessionId): Promise<readonly Answer[]>;
}
