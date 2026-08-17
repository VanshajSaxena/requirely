import type {
  Answer,
  AnswerId,
  InquiryRepository,
  Question,
  QuestionId,
  RevisionId,
  Session,
  SessionId,
  SessionRepository,
  Source,
  SourceId,
  SourceRepository,
  Turn,
  UnderstandingRepository,
  UnderstandingRevision,
} from '../../domain/index.ts';

/**
 * In-memory implementations of the four repository ports.
 *
 * These exist to run the loop end to end before Postgres arrives, and to prove
 * the port shapes are implementable before Drizzle locks them in.
 *
 * Everything is deep-cloned on the way in and out. That is not paranoia: the
 * real adapter will serialize through JSONB, so shared references would work
 * here and break there. Cloning makes the in-memory adapter fail the same way
 * the real one would, which is the only reason a fake adapter is worth trusting.
 */

const clone = <T>(value: T): T => structuredClone(value);

export function inMemorySessionRepository(): SessionRepository {
  const sessions = new Map<string, Session>();
  const turns = new Map<string, Turn[]>();

  return {
    async create(session) {
      sessions.set(session.id, clone(session));
    },
    async findById(id: SessionId) {
      const found = sessions.get(id);
      return found ? clone(found) : null;
    },
    async save(session) {
      sessions.set(session.id, clone(session));
    },
    async appendTurn(turn: Turn) {
      const existing = turns.get(turn.sessionId) ?? [];
      existing.push(clone(turn));
      turns.set(turn.sessionId, existing);
    },
    async listTurns(sessionId: SessionId) {
      return (turns.get(sessionId) ?? []).map(clone);
    },
  };
}

export function inMemorySourceRepository(): SourceRepository {
  const sources = new Map<string, Source>();

  return {
    async add(source) {
      sources.set(source.id, clone(source));
    },
    async save(source) {
      sources.set(source.id, clone(source));
    },
    async findById(id: SourceId) {
      const found = sources.get(id);
      return found ? clone(found) : null;
    },
    async listBySession(sessionId: SessionId) {
      return [...sources.values()].filter((s) => s.sessionId === sessionId).map(clone);
    },
  };
}

export function inMemoryUnderstandingRepository(): UnderstandingRepository {
  const revisions = new Map<string, UnderstandingRevision>();

  const bySession = (sessionId: SessionId): UnderstandingRevision[] =>
    [...revisions.values()]
      .filter((r) => r.sessionId === sessionId)
      .sort((a, b) => a.revision - b.revision);

  return {
    async append(revision) {
      revisions.set(revision.id, clone(revision));
    },
    async findById(id: RevisionId) {
      const found = revisions.get(id);
      return found ? clone(found) : null;
    },
    async findLatest(sessionId: SessionId) {
      const all = bySession(sessionId);
      const last = all[all.length - 1];
      return last ? clone(last) : null;
    },
    async listBySession(sessionId: SessionId) {
      return bySession(sessionId).map(clone);
    },
  };
}

export function inMemoryInquiryRepository(): InquiryRepository {
  const questions = new Map<string, Question>();
  const answers = new Map<string, Answer>();

  return {
    async addQuestions(incoming) {
      for (const question of incoming) questions.set(question.id, clone(question));
    },
    async findQuestion(id: QuestionId) {
      const found = questions.get(id);
      return found ? clone(found) : null;
    },
    async listUnansweredQuestions(sessionId: SessionId) {
      const answered = new Set([...answers.values()].map((a) => a.questionId as string));
      return [...questions.values()]
        .filter((q) => q.sessionId === sessionId && !answered.has(q.id))
        .map(clone);
    },
    async addAnswer(answer) {
      answers.set(answer.id, clone(answer));
    },
    async findAnswer(id: AnswerId) {
      const found = answers.get(id);
      return found ? clone(found) : null;
    },
    async listAnswers(sessionId: SessionId) {
      const sessionQuestions = new Set(
        [...questions.values()].filter((q) => q.sessionId === sessionId).map((q) => q.id as string),
      );
      return [...answers.values()].filter((a) => sessionQuestions.has(a.questionId)).map(clone);
    },
  };
}

export interface MemoryStores {
  readonly sessions: SessionRepository;
  readonly sources: SourceRepository;
  readonly understanding: UnderstandingRepository;
  readonly inquiry: InquiryRepository;
}

export function inMemoryStores(): MemoryStores {
  return {
    sessions: inMemorySessionRepository(),
    sources: inMemorySourceRepository(),
    understanding: inMemoryUnderstandingRepository(),
    inquiry: inMemoryInquiryRepository(),
  };
}
