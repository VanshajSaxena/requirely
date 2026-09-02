import { and, desc, type ExtractTablesWithRelations, eq, isNull, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  Answer,
  type AnswerId,
  type InquiryRepository,
  Question,
  type QuestionId,
  type RevisionId,
  Session,
  type SessionId,
  type SessionRepository,
  Source,
  type SourceId,
  type SourceRepository,
  type Timestamp,
  Turn,
  TurnCommit,
  type TurnCommitter,
  type UnderstandingRepository,
  UnderstandingRevision,
} from '../../../domain/index.ts';
import {
  answers,
  questions,
  type Schema,
  sessions,
  sources,
  turns,
  understandingRevisions,
} from './schema.ts';

/**
 * Postgres implementations of every storage port.
 *
 * Typed against drizzle's `PgDatabase` base rather than a concrete driver, so
 * the same code runs on postgres-js (production) and PGlite (tests). If those
 * two diverged, the tests would stop being evidence about production.
 *
 * **Every read goes through `Entity.parse(row)`.** The database is an untrusted
 * boundary in exactly the way a model is: a column changed by a migration, a
 * hand-edited row, or a JSONB blob written by an older version of the code all
 * arrive here as unvalidated data. Casting would let those through silently.
 */

export type Database = PgDatabase<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

// ---------------------------------------------------------------- mappers

type SessionRow = typeof sessions.$inferSelect;
type SourceRow = typeof sources.$inferSelect;
type RevisionRow = typeof understandingRevisions.$inferSelect;
type TurnRow = typeof turns.$inferSelect;
type QuestionRow = typeof questions.$inferSelect;
type AnswerRow = typeof answers.$inferSelect;

/**
 * The timestamp boundary, in one place.
 *
 * Columns are `timestamptz(3)`, so the driver hands back a `Date` and expects a
 * `Date`; the domain speaks ISO-8601 strings. Keeping the conversion to two
 * functions means the next question about representation has exactly one
 * address, the way `engine/context.ts` is the only place model input is built.
 *
 * `new Date()` here is not ambient time — the instant always originates from the
 * domain's `Clock`. (The determinism boundary rule covers `domain/` and
 * `engine/` only, which is why this is legal here and nowhere inward.)
 */
const toTimestamp = (value: Date): Timestamp => value.toISOString();
const fromTimestamp = (value: Timestamp): Date => new Date(value);

// `version` is intentionally absent from the domain Session, so it is dropped here.
const toSession = (row: SessionRow): Session =>
  Session.parse({
    ...row,
    createdAt: toTimestamp(row.createdAt),
    updatedAt: toTimestamp(row.updatedAt),
  });

const toSource = (row: SourceRow): Source =>
  Source.parse({ ...row, ingestedAt: toTimestamp(row.ingestedAt) });

const toRevision = (row: RevisionRow): UnderstandingRevision =>
  UnderstandingRevision.parse({ ...row, createdAt: toTimestamp(row.createdAt) });

const toTurn = (row: TurnRow): Turn =>
  Turn.parse({
    ...row,
    index: row.turnIndex,
    turnIndex: undefined,
    startedAt: toTimestamp(row.startedAt),
    completedAt: toTimestamp(row.completedAt),
  });

const toQuestion = (row: QuestionRow): Question =>
  // `allowsCustom` has no column: the domain pins it to `true`, so it is
  // reconstructed rather than stored.
  Question.parse({ ...row, allowsCustom: true, askedAt: toTimestamp(row.askedAt) });

const toAnswer = (row: AnswerRow): Answer =>
  Answer.parse({ ...row, answeredAt: toTimestamp(row.answeredAt) });

const sessionValues = (session: Session) => ({
  id: session.id,
  title: session.title,
  status: session.status,
  outputTarget: session.outputTarget,
  questionBudget: session.questionBudget,
  questionsAsked: session.questionsAsked,
  currentRevisionId: session.currentRevisionId,
  createdAt: fromTimestamp(session.createdAt),
  updatedAt: fromTimestamp(session.updatedAt),
});

const sourceValues = (source: Source) => ({
  id: source.id,
  sessionId: source.sessionId,
  kind: source.kind,
  status: source.status,
  derivedBy: source.derivedBy,
  origin: source.origin,
  normalizedText: source.normalizedText,
  segments: source.segments === null ? null : [...source.segments],
  failureReason: source.failureReason,
  ingestedAt: fromTimestamp(source.ingestedAt),
});

// ---------------------------------------------------------------- repositories

export function postgresSessionRepository(db: Database): SessionRepository {
  return {
    async create(session) {
      await db.insert(sessions).values(sessionValues(session));
    },

    async findById(id: SessionId) {
      const [row] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      return row ? toSession(row) : null;
    },

    async save(session) {
      // Upsert, matching the in-memory adapter's `set` semantics. The shared
      // contract suite is what forces the two to agree on this.
      const values = sessionValues(session);
      await db
        .insert(sessions)
        .values(values)
        .onConflictDoUpdate({
          target: sessions.id,
          set: { ...values, version: sql`${sessions.version} + 1` },
        });
    },

    async listRecent(limit: number) {
      // `updatedAt` descending: activity, not creation. This is also the query
      // that made `timestamptz` worth the Phase 3a correction — as `text` it
      // needed a cast, which defeats the index.
      const rows = await db
        .select()
        .from(sessions)
        .orderBy(desc(sessions.updatedAt), desc(sessions.id))
        .limit(limit);
      return rows.map(toSession);
    },

    async listTurns(sessionId: SessionId) {
      const rows = await db
        .select()
        .from(turns)
        .where(eq(turns.sessionId, sessionId))
        .orderBy(turns.turnIndex);
      return rows.map(toTurn);
    },
  };
}

export function postgresSourceRepository(db: Database): SourceRepository {
  const upsert = async (source: Source) => {
    const values = sourceValues(source);
    await db
      .insert(sources)
      .values(values)
      // Conflict target is the composite key, since a source id is only unique
      // within its session.
      .onConflictDoUpdate({ target: [sources.sessionId, sources.id], set: values });
  };

  return {
    add: upsert,
    save: upsert,

    async findById(sessionId: SessionId, id: SourceId) {
      const [row] = await db
        .select()
        .from(sources)
        .where(and(eq(sources.sessionId, sessionId), eq(sources.id, id)))
        .limit(1);
      return row ? toSource(row) : null;
    },

    async remove(sessionId: SessionId, id: SourceId) {
      // Idempotent: a DELETE matching nothing is a no-op, which matches the
      // in-memory adapter and matters because the only caller is failure cleanup.
      await db.delete(sources).where(and(eq(sources.sessionId, sessionId), eq(sources.id, id)));
    },

    async listBySession(sessionId: SessionId) {
      const rows = await db
        .select()
        .from(sources)
        .where(eq(sources.sessionId, sessionId))
        .orderBy(sources.id);
      return rows.map(toSource);
    },
  };
}

export function postgresUnderstandingRepository(db: Database): UnderstandingRepository {
  return {
    async findById(id: RevisionId) {
      const [row] = await db
        .select()
        .from(understandingRevisions)
        .where(eq(understandingRevisions.id, id))
        .limit(1);
      return row ? toRevision(row) : null;
    },

    async findLatest(sessionId: SessionId) {
      const [row] = await db
        .select()
        .from(understandingRevisions)
        .where(eq(understandingRevisions.sessionId, sessionId))
        .orderBy(sql`${understandingRevisions.revision} desc`)
        .limit(1);
      return row ? toRevision(row) : null;
    },

    async listBySession(sessionId: SessionId) {
      const rows = await db
        .select()
        .from(understandingRevisions)
        .where(eq(understandingRevisions.sessionId, sessionId))
        .orderBy(understandingRevisions.revision);
      return rows.map(toRevision);
    },
  };
}

export function postgresInquiryRepository(db: Database): InquiryRepository {
  return {
    async findQuestion(id: QuestionId) {
      const [row] = await db.select().from(questions).where(eq(questions.id, id)).limit(1);
      return row ? toQuestion(row) : null;
    },

    async listQuestions(sessionId: SessionId) {
      const rows = await db
        .select()
        .from(questions)
        .where(eq(questions.sessionId, sessionId))
        .orderBy(questions.askedAt, questions.id);
      return rows.map(toQuestion);
    },

    async listUnansweredQuestions(sessionId: SessionId) {
      const rows = await db
        .select({ question: questions })
        .from(questions)
        .leftJoin(answers, eq(answers.questionId, questions.id))
        .where(and(eq(questions.sessionId, sessionId), isNull(answers.id)))
        .orderBy(questions.askedAt, questions.id);
      return rows.map((row) => toQuestion(row.question));
    },

    async findAnswer(id: AnswerId) {
      const [row] = await db.select().from(answers).where(eq(answers.id, id)).limit(1);
      return row ? toAnswer(row) : null;
    },

    async listAnswers(sessionId: SessionId) {
      const rows = await db
        .select({ answer: answers })
        .from(answers)
        .innerJoin(questions, eq(answers.questionId, questions.id))
        .where(eq(questions.sessionId, sessionId))
        .orderBy(answers.answeredAt, answers.id);
      return rows.map((row) => toAnswer(row.answer));
    },
  };
}

/**
 * Writes a whole turn in one transaction.
 *
 * The transaction is short by construction: every model call already happened
 * before this was called, so nothing slow runs inside it. Insert order follows
 * the foreign keys — questions before answers, since an answer references a
 * question (possibly one raised by an earlier turn, which already exists).
 */
export function postgresTurnCommitter(db: Database): TurnCommitter {
  return {
    async commit(incoming) {
      const command = TurnCommit.parse(incoming);

      await db.transaction(async (tx) => {
        await tx.insert(understandingRevisions).values({
          id: command.revision.id,
          sessionId: command.revision.sessionId,
          revision: command.revision.revision,
          producedByTurnId: command.revision.producedByTurnId,
          content: command.revision.content,
          createdAt: fromTimestamp(command.revision.createdAt),
        });

        await tx.insert(turns).values({
          id: command.turn.id,
          sessionId: command.turn.sessionId,
          turnIndex: command.turn.index,
          trigger: command.turn.trigger,
          inputSourceIds: [...command.turn.inputSourceIds],
          inputAnswerIds: [...command.turn.inputAnswerIds],
          understandingBefore: command.turn.understandingBefore,
          understandingAfter: command.turn.understandingAfter,
          verdict: command.turn.verdict,
          usage: [...command.turn.usage],
          startedAt: fromTimestamp(command.turn.startedAt),
          completedAt: fromTimestamp(command.turn.completedAt),
        });

        if (command.questions.length > 0) {
          await tx.insert(questions).values(
            command.questions.map((question) => ({
              id: question.id,
              sessionId: question.sessionId,
              turnId: question.turnId,
              dimension: question.dimension,
              about: question.about,
              text: question.text,
              mode: question.mode,
              options: [...question.options],
              rationale: question.rationale,
              recommends: question.recommends,
              because: question.because,
              askedAt: fromTimestamp(question.askedAt),
            })),
          );
        }

        if (command.answers.length > 0) {
          await tx.insert(answers).values(
            command.answers.map((answer) => ({
              id: answer.id,
              questionId: answer.questionId,
              selectedOptionIds: [...answer.selectedOptionIds],
              customText: answer.customText,
              additionalContext: answer.additionalContext,
              answeredAt: fromTimestamp(answer.answeredAt),
            })),
          );
        }

        const values = sessionValues(command.session);
        await tx
          .insert(sessions)
          .values(values)
          .onConflictDoUpdate({
            target: sessions.id,
            set: { ...values, version: sql`${sessions.version} + 1` },
          });
      });
    },
  };
}

export interface PostgresStores {
  readonly sessions: SessionRepository;
  readonly sources: SourceRepository;
  readonly understanding: UnderstandingRepository;
  readonly inquiry: InquiryRepository;
  readonly committer: TurnCommitter;
}

export function postgresStores(db: Database): PostgresStores {
  return {
    sessions: postgresSessionRepository(db),
    sources: postgresSourceRepository(db),
    understanding: postgresUnderstandingRepository(db),
    inquiry: postgresInquiryRepository(db),
    committer: postgresTurnCommitter(db),
  };
}
