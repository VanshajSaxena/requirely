import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type {
  QuestionOption,
  SourceOrigin,
  SufficiencyVerdict,
  Temperament,
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
 * **Timestamps are `timestamptz(3)`.** An earlier version used `text` on the
 * reasoning that the domain holds ISO-8601 strings, so storing them verbatim
 * avoided a conversion. Measurement overturned that:
 *
 * - Text ordering is only correct if *every* writer emits the identical
 *   canonical format. `'2026-01-01T23:00:00+05:30' > '2026-01-01T18:00:00.000Z'`
 *   is `true` as text and `false` in reality — and no constraint can stop a
 *   non-UTC offset being inserted.
 * - A `text` column accepts `'not a date'`. This file calls the database an
 *   untrusted boundary; `text` discards the one check Postgres gives for free.
 * - Any temporal predicate needs `::timestamptz`, and casting a column defeats
 *   its index. Measured: seq scan on text vs index-only scan on timestamptz for
 *   the same `WHERE col > now() - interval '7 days'`.
 *
 * `precision: 3` is the part worth keeping from the original concern. Postgres
 * stores microseconds; `Date.toISOString()` represents milliseconds. Pinning the
 * column to millisecond precision makes lossless round-tripping a schema
 * guarantee rather than something that merely happens to hold while our code is
 * the only writer.
 *
 * **Nested domain objects are `jsonb`.** The Understanding is a versioned
 * document, not a set of rows — shredding it into tables would make every
 * revision an expensive multi-table write and destroy the snapshot model.
 * `$type<T>()` gives insert-time safety; reads are still re-parsed with Zod,
 * because the database is an untrusted boundary exactly like a model is.
 */

/**
 * Millisecond precision, matching exactly what `Date.toISOString()` can express.
 * Anything finer would be storable but not representable in the domain.
 */
const MILLISECOND_UTC = { withTimezone: true, precision: 3 } as const;

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  title: text('title'),
  status: text('status').notNull(),
  outputTarget: text('output_target'),
  questionBudget: integer('question_budget').notNull(),
  questionsAsked: integer('questions_asked').notNull(),
  /**
   * The five dials, as one JSONB object rather than five numeric columns.
   *
   * They are read and written together, never queried individually, and adding a
   * sixth dial should not be a migration. The domain schema is the gate on read,
   * exactly as it is for `understanding_revisions.content`.
   */
  temperament: jsonb('temperament').$type<Temperament>().notNull(),
  currentRevisionId: text('current_revision_id'),
  /**
   * Bumped on every write but not yet enforced. Present from the first migration
   * because adding it later means a migration against live data plus revisiting
   * every write site; enforcing it later is just a WHERE clause. Deliberately
   * absent from the domain `Session` — this is a persistence concern.
   */
  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', MILLISECOND_UTC).notNull(),
  updatedAt: timestamp('updated_at', MILLISECOND_UTC).notNull(),
});

/**
 * `PRIMARY KEY (session_id, id)` with `id = 'src-1'`.
 *
 * A source belongs to exactly one session — the FK is already NOT NULL with
 * cascade — so a session-scoped id is the honest model. It also makes the one
 * table primary key a model must emit (`provenance.sourceId`) short enough to
 * copy back reliably. Nothing FK-references `sources`, so this costs no ripple.
 */
export const sources = pgTable(
  'sources',
  {
    id: text('id').notNull(),
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
    ingestedAt: timestamp('ingested_at', MILLISECOND_UTC).notNull(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.id] })],
);

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
    createdAt: timestamp('created_at', MILLISECOND_UTC).notNull(),
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
    /** What this turn actually ran under — see the note on `Turn.temperament`. */
    temperament: jsonb('temperament').$type<Temperament>().notNull(),
    usage: jsonb('usage').$type<Usage[]>().notNull(),
    startedAt: timestamp('started_at', MILLISECOND_UTC).notNull(),
    completedAt: timestamp('completed_at', MILLISECOND_UTC).notNull(),
  },
  (table) => [uniqueIndex('turns_session_index_key').on(table.sessionId, table.turnIndex)],
);

export const questions = pgTable('questions', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  turnId: text('turn_id').notNull(),
  dimension: text('dimension').notNull(),
  // Nullable: a question about an absence targets a dimension and no item.
  about: text('about'),
  text: text('text').notNull(),
  mode: text('mode').notNull(),
  // `commits` and `settles` ride inside this JSONB, so an option's consequence
  // is stored with the option rather than in a parallel table that could drift.
  options: jsonb('options').$type<QuestionOption[]>().notNull(),
  // Not null any more: a question with no stated reason is a form field, and the
  // domain now refuses to construct one.
  rationale: text('rationale').notNull(),
  /** Nullable together — the domain enforces that they are set or unset as a pair. */
  recommends: text('recommends'),
  because: text('because'),
  askedAt: timestamp('asked_at', MILLISECOND_UTC).notNull(),
});

export const answers = pgTable('answers', {
  id: text('id').primaryKey(),
  questionId: text('question_id')
    .notNull()
    .references(() => questions.id, { onDelete: 'cascade' }),
  selectedOptionIds: jsonb('selected_option_ids').$type<string[]>().notNull(),
  customText: text('custom_text'),
  additionalContext: text('additional_context'),
  answeredAt: timestamp('answered_at', MILLISECOND_UTC).notNull(),
});

// `allowsCustom` is deliberately not a column: the domain pins it to
// `z.literal(true)`, so storing it would only create a way for the database to
// disagree with an invariant that cannot vary.

export const schema = { sessions, sources, understandingRevisions, turns, questions, answers };
export type Schema = typeof schema;
