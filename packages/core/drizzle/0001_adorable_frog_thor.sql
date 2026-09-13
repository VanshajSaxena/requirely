-- Temperament: the five dials, on the session and on every turn.
--
-- HAND-EDITED after generation, and the edit matters. drizzle-kit emitted a bare
--   ALTER TABLE "sessions" ADD COLUMN "temperament" jsonb NOT NULL;
-- which is correct against an empty database and fails against any table that
-- already holds a row. It is generated SQL, not authoritative SQL — the repo's
-- own rule is to review it the way you would review hand-written DDL.
--
-- Why 0001 rather than regenerating 0000 in place, which is what every previous
-- schema change did: that pattern rested on "the journal has one entry and it has
-- never been applied anywhere." Phase 9 made that false by standing up a real
-- local Postgres and running sessions through it. First time the premise does not
-- hold, so this is a real migration.
--
-- The backfill value is `scribe`, not `balanced`, and that is deliberate. Rows
-- written before this migration ran under prompts that said "be conservative" and
-- "an assumption is a LAST RESORT" — which is what `scribe` encodes. Stamping
-- them `balanced` would put a number on history that history did not have, and
-- `turns.temperament` exists precisely to be an honest audit record.
--
-- The DEFAULT is dropped immediately afterwards: it exists to satisfy NOT NULL
-- for rows that already exist, and leaving it in place would let a future insert
-- silently acquire `scribe` instead of failing. Application code always supplies
-- the value.

ALTER TABLE "sessions" ADD COLUMN "temperament" jsonb NOT NULL
  DEFAULT '{"creativity":0.1,"assertiveness":0.2,"technicality":0.9,"thoroughness":0.8,"curiosity":0.6}'::jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "temperament" DROP DEFAULT;--> statement-breakpoint

ALTER TABLE "turns" ADD COLUMN "temperament" jsonb NOT NULL
  DEFAULT '{"creativity":0.1,"assertiveness":0.2,"technicality":0.9,"thoroughness":0.8,"curiosity":0.6}'::jsonb;--> statement-breakpoint
ALTER TABLE "turns" ALTER COLUMN "temperament" DROP DEFAULT;
