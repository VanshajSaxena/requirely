-- `QuestionOption.commits` -> `means`, inside the `questions.options` JSONB.
--
-- WRITTEN BY HAND, because drizzle-kit cannot produce this one and did not try.
-- `options` is declared `jsonb('options').$type<QuestionOption[]>()`, and `$type<>`
-- is a TypeScript assertion with no runtime or DDL presence — so a rename inside
-- that column is invisible to schema diffing. `pnpm db:generate` emitted 0001 and
-- 0002 for two column ADDITIONS and said nothing about this, because from its
-- point of view nothing changed.
--
-- The three shape changes in that phase had three different fates, which is worth
-- keeping in mind before the next one:
--
--   added    temperament, disposition -> real columns -> drizzle-kit saw them
--   deleted  elaboration              -> still stored, HARMLESS: Zod strips
--                                        unknown keys on read
--   renamed  commits -> means         -> invisible to drizzle-kit AND fatal to
--                                        Zod, because the new name is required
--                                        and the old one is silently ignored
--
-- A rename is the only one that is both undetectable and fatal. Everything else
-- degraded safely on its own.
--
-- `elaboration` is folded INTO `means` rather than dropped. The new field asks for
-- "what this option is, when it fits, or what it costs", and the old pair split
-- exactly that: `elaboration` said what the option was, `commits` said what it
-- cost. Concatenating preserves both and produces better content than either
-- alone, which is what the field now wants. Dropping it would discard real model
-- output to save bytes.

UPDATE questions q
SET options = (
  SELECT jsonb_agg(
           (elem - 'commits' - 'elaboration')
           || jsonb_build_object(
                'means',
                to_jsonb(
                  CASE
                    WHEN elem ? 'elaboration' AND nullif(elem ->> 'elaboration', '') IS NOT NULL
                      THEN rtrim(elem ->> 'elaboration', '.') || '. ' || (elem ->> 'commits')
                    ELSE elem ->> 'commits'
                  END
                )
              )
           -- Option order is meaningful: `recommends` used to be an index into
           -- this array at draft time, and the CLI prints them "most likely
           -- first". `jsonb_agg` without ORDER BY has no defined order.
           ORDER BY ord
         )
  FROM jsonb_array_elements(q.options) WITH ORDINALITY AS t(elem, ord)
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(q.options) e WHERE e ? 'commits'
);
