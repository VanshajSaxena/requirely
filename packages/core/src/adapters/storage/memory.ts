import {
  type Answer,
  type AnswerId,
  type InquiryRepository,
  type Question,
  type QuestionId,
  type RevisionId,
  type Session,
  type SessionId,
  type SessionRepository,
  type Source,
  type SourceId,
  type SourceRepository,
  type Turn,
  TurnCommit,
  type TurnCommitter,
  type UnderstandingRepository,
  type UnderstandingRevision,
} from '../../domain/index.ts';

/**
 * In-memory implementation of every storage port.
 *
 * Two jobs: keep engine tests instant and database-free, and act as the
 * reference implementation that the Postgres adapter is checked against. Both
 * are held to the same contract suite in `contract.ts` — two implementations
 * with separate tests drift; two implementations with one test suite do not.
 *
 * Everything is deep-cloned in and out. Not paranoia: the real adapter
 * serializes through JSONB, so a shared reference would work here and break
 * there. The fake has to fail the same way the real one will, or trusting it is
 * a mistake.
 */

const clone = <T>(value: T): T => structuredClone(value);

/**
 * Source ids are unique per session, not globally, so the in-memory map needs a
 * compound key — mirroring the composite primary key Postgres uses. A plain `id`
 * key would let two sessions' `src-1` collide here while working in Postgres,
 * which is the kind of divergence the shared contract suite exists to catch.
 */
const sourceKey = (sessionId: string, id: string): string => `${sessionId}\u0000${id}`;

interface Tables {
  readonly sessions: Map<string, Session>;
  readonly turns: Map<string, Turn[]>;
  readonly sources: Map<string, Source>;
  readonly revisions: Map<string, UnderstandingRevision>;
  readonly questions: Map<string, Question>;
  readonly answers: Map<string, Answer>;
}

export interface MemoryStores {
  readonly sessions: SessionRepository;
  readonly sources: SourceRepository;
  readonly understanding: UnderstandingRepository;
  readonly inquiry: InquiryRepository;
  readonly committer: TurnCommitter;
}

export function inMemoryStores(): MemoryStores {
  const db: Tables = {
    sessions: new Map(),
    turns: new Map(),
    sources: new Map(),
    revisions: new Map(),
    questions: new Map(),
    answers: new Map(),
  };

  const revisionsOf = (sessionId: SessionId): UnderstandingRevision[] =>
    [...db.revisions.values()]
      .filter((revision) => revision.sessionId === sessionId)
      .sort((a, b) => a.revision - b.revision);

  const sessions: SessionRepository = {
    async create(session) {
      db.sessions.set(session.id, clone(session));
    },
    async findById(id: SessionId) {
      const found = db.sessions.get(id);
      return found ? clone(found) : null;
    },
    async save(session) {
      db.sessions.set(session.id, clone(session));
    },
    async listRecent(limit: number) {
      return [...db.sessions.values()]
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
        .slice(0, limit)
        .map(clone);
    },
    async listTurns(sessionId: SessionId) {
      return (db.turns.get(sessionId) ?? []).map(clone);
    },
  };

  const sources: SourceRepository = {
    async add(source) {
      db.sources.set(sourceKey(source.sessionId, source.id), clone(source));
    },
    async save(source) {
      db.sources.set(sourceKey(source.sessionId, source.id), clone(source));
    },
    async findById(sessionId: SessionId, id: SourceId) {
      const found = db.sources.get(sourceKey(sessionId, id));
      return found ? clone(found) : null;
    },
    async remove(sessionId: SessionId, id: SourceId) {
      // Idempotent: removing something already gone is not an error, which
      // matters because the only caller is failure cleanup.
      db.sources.delete(sourceKey(sessionId, id));
    },
    async listBySession(sessionId: SessionId) {
      return [...db.sources.values()].filter((s) => s.sessionId === sessionId).map(clone);
    },
  };

  const understanding: UnderstandingRepository = {
    async findById(id: RevisionId) {
      const found = db.revisions.get(id);
      return found ? clone(found) : null;
    },
    async findLatest(sessionId: SessionId) {
      const all = revisionsOf(sessionId);
      const last = all[all.length - 1];
      return last ? clone(last) : null;
    },
    async listBySession(sessionId: SessionId) {
      return revisionsOf(sessionId).map(clone);
    },
  };

  const inquiry: InquiryRepository = {
    async findQuestion(id: QuestionId) {
      const found = db.questions.get(id);
      return found ? clone(found) : null;
    },
    async listQuestions(sessionId: SessionId) {
      return [...db.questions.values()].filter((q) => q.sessionId === sessionId).map(clone);
    },
    async listUnansweredQuestions(sessionId: SessionId) {
      const answered = new Set([...db.answers.values()].map((a) => a.questionId as string));
      return [...db.questions.values()]
        .filter((q) => q.sessionId === sessionId && !answered.has(q.id))
        .map(clone);
    },
    async findAnswer(id: AnswerId) {
      const found = db.answers.get(id);
      return found ? clone(found) : null;
    },
    async listAnswers(sessionId: SessionId) {
      const ofSession = new Set(
        [...db.questions.values()]
          .filter((q) => q.sessionId === sessionId)
          .map((q) => q.id as string),
      );
      return [...db.answers.values()].filter((a) => ofSession.has(a.questionId)).map(clone);
    },
  };

  const committer: TurnCommitter = {
    async commit(incoming) {
      const command = TurnCommit.parse(incoming);

      // Postgres enforces these through primary keys and unique indexes. A Map
      // would happily overwrite instead, which made this adapter *more*
      // permissive than production — a bug could pass here and fail there.
      // The shared contract suite caught exactly that, so the constraints are
      // reproduced by hand.
      const existingTurns = db.turns.get(command.turn.sessionId) ?? [];
      const conflicts = [
        db.revisions.has(command.revision.id) && `revision ${command.revision.id} already exists`,
        [...db.revisions.values()].some(
          (r) =>
            r.sessionId === command.revision.sessionId && r.revision === command.revision.revision,
        ) && `session already has revision number ${command.revision.revision}`,
        existingTurns.some((t) => t.id === command.turn.id) &&
          `turn ${command.turn.id} already exists`,
        existingTurns.some((t) => t.index === command.turn.index) &&
          `session already has turn index ${command.turn.index}`,
        ...command.questions.map(
          (q) => db.questions.has(q.id) && `question ${q.id} already exists`,
        ),
        ...command.answers.map((a) => db.answers.has(a.id) && `answer ${a.id} already exists`),
      ].filter((conflict): conflict is string => typeof conflict === 'string');

      if (conflicts.length > 0) {
        throw new Error(`Commit conflicts with stored data: ${conflicts.join('; ')}`);
      }

      // Everything below is a synchronous Map write, so once the checks above
      // pass there is no partial-failure path — this adapter's stand-in for a
      // transaction.
      db.sessions.set(command.session.id, clone(command.session));
      db.revisions.set(command.revision.id, clone(command.revision));

      const existing = existingTurns;
      existing.push(clone(command.turn));
      db.turns.set(command.turn.sessionId, existing);

      for (const question of command.questions) db.questions.set(question.id, clone(question));
      for (const answer of command.answers) db.answers.set(answer.id, clone(answer));
    },
  };

  return { sessions, sources, understanding, inquiry, committer };
}
