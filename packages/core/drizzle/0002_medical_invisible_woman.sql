-- What the user did with a question: answered, deferred, or delegated.
--
-- HAND-EDITED after generation, for the same reason as 0001: drizzle-kit emits a
-- bare `ADD COLUMN ... NOT NULL`, which is correct against an empty database and
-- fails against any table holding a row.
--
-- Backfilled to 'answered', and here that is not a compromise — it is exactly
-- true. Before this column existed, `validateAnswer` rejected an answer that
-- selected nothing and wrote nothing, so every row that can possibly be in this
-- table carries content. There was no way to record a deferral, which is the
-- hole this migration exists to close.
--
-- The DEFAULT is dropped immediately: it exists to satisfy NOT NULL for the rows
-- already there. Leaving it would let a future insert silently acquire
-- 'answered' when the application meant to say something else, and "silently
-- acquired the wrong disposition" is a worse failure than "insert rejected".

ALTER TABLE "answers" ADD COLUMN "disposition" text NOT NULL DEFAULT 'answered';--> statement-breakpoint
ALTER TABLE "answers" ALTER COLUMN "disposition" DROP DEFAULT;
