import { integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type {
  QuestionOption,
  SourceOrigin,
  SufficiencyVerdict,
  TranscriptSegment,
  Understanding,
  Usage,
} from '../../../domain/index.ts';

/**
 * Postgres schema.
 *
 * Three decisions worth knowing before changing anything here:
 *
 * **IDs are `text`, not `uuid`.** They carry kind prefixes (`req_0193…`) so they
 * are self-describing in logs and in a model's context window. The UUID part is
 * v7, so they still sort chronologically.
 *
 * **Timestamps are `text`, not `timestamptz`.** The domain's `Timestamp` is an
 * ISO-8601 UTC string and `round-trip.test.ts` asserts every entity survives
 * serialization byte-identically. `timestamptz` returns a `Date` that has to be
 * converted back, which reintroduces exactly the precision question the rest of
 * the codebase avoids. ISO-8601 UTC also sorts correctly as text, so ordering
 * still works; the only cost is a `::timestamptz` cast for SQL-side date
 * arithmetic, which nothing currently does.
 *
 * **Nested domain objects are `jsonb`.** The Understanding is a versioned
 * document, not a set of rows — shredding it into tables would make every
 * revision an expensive multi-table write and destroy the snapshot model.
 * `$type<T>()` gives insert-time safety; reads are still re-parsed with Zod,
 * because the database is an untrusted boundary exactly like a model is.
 */

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  title: text('title'),
  status: text('status').notNull(),
  outputTarget: text('output_target'),
  questionBudget: integer('question_budget').notNull(),
  questionsAsked: integer('questions_asked').notNull(),
  currentRevisionId: text('current_revision_id'),
  /**
   * Bumped on every write but not yet enforced. Present from the first migration
   * because adding it later means a migration against live data plus revisiting
   * every write site; enforcing it later is just a WHERE clause. Deliberately
   * absent from the domain `Session` — this is a persistence concern.
   */
  version: integer('version').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const sources = pgTable('sources', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  status: text('status').notNull(),
  derivedBy: text('derived_by').notNull(),
  origin: jsonb('origin').$type<SourceOrigin>().notNull(),
  normalizedText: text('normalized_text'),
  segments: jsonb('segments').$type<TranscriptSegment[] | null>(),
  failureReason: text('failure_reason'),
  ingestedAt: text('ingested_at').notNull(),
});

export const understandingRevisions = pgTable(
  'understanding_revisions',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    producedByTurnId: text('produced_by_turn_id'),
    content: jsonb('content').$type<Understanding>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  // Makes the append-only sequence the database's problem rather than the
  // application's hope. A duplicate revision number is now impossible.
  (table) => [uniqueIndex('revisions_session_revision_key').on(table.sessionId, table.revision)],
);

export const turns = pgTable(
  'turns',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    turnIndex: integer('turn_index').notNull(),
    trigger: text('trigger').notNull(),
    inputSourceIds: jsonb('input_source_ids').$type<string[]>().notNull(),
    inputAnswerIds: jsonb('input_answer_ids').$type<string[]>().notNull(),
    understandingBefore: text('understanding_before'),
    understandingAfter: text('understanding_after').notNull(),
    verdict: jsonb('verdict').$type<SufficiencyVerdict>().notNull(),
    usage: jsonb('usage').$type<Usage[]>().notNull(),
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at').notNull(),
  },
  (table) => [uniqueIndex('turns_session_index_key').on(table.sessionId, table.turnIndex)],
);

export const questions = pgTable('questions', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  turnId: text('turn_id').notNull(),
  gapId: text('gap_id').notNull(),
  text: text('text').notNull(),
  mode: text('mode').notNull(),
  options: jsonb('options').$type<QuestionOption[]>().notNull(),
  rationale: text('rationale'),
  askedAt: text('asked_at').notNull(),
});

export const answers = pgTable('answers', {
  id: text('id').primaryKey(),
  questionId: text('question_id')
    .notNull()
    .references(() => questions.id, { onDelete: 'cascade' }),
  selectedOptionIds: jsonb('selected_option_ids').$type<string[]>().notNull(),
  customText: text('custom_text'),
  additionalContext: text('additional_context'),
  answeredAt: text('answered_at').notNull(),
});

// `allowsCustom` is deliberately not a column: the domain pins it to
// `z.literal(true)`, so storing it would only create a way for the database to
// disagree with an invariant that cannot vary.

export const schema = { sessions, sources, understandingRevisions, turns, questions, answers };
export type Schema = typeof schema;
