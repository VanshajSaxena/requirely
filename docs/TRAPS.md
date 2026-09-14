# Traps

Things that cost hours once and must not cost them again.

**Not weaknesses.** Nothing here is open work and nothing here has a fix — a trap
stays true for as long as the tool does. They lived in `docs/WEAKNESSES.md` and
were moved out because that file is a backlog: mixing permanent facts into it made
the real open work look larger than it was, and made the list look unshrinkable
when most of it was never going to shrink.

Most of these are also recorded in the `CLAUDE.md` file nearest the code that hits
them, which is where you *will* hit them. This is the version you read on purpose.

---

- **`pnpm test` passing is not evidence Node can run the code.** Vitest transpiles
  with its own pipeline. `pnpm node-runnable` is the gate that observes it.
- **pnpm 11 ignores the `pnpm` field in `package.json`** — settings live in
  `pnpm-workspace.yaml`, silently. `esbuild` needs *both* `onlyBuiltDependencies`
  and `allowBuilds` there, or `pnpm install` exits non-zero.
- **Biome `overrides` entries *replace* each other per rule rather than merging.**
  An early boundary config silently caught only 2 of 4 planted violations. After
  changing any boundary rule, re-prove it by planting deliberate violations.
- **A comment in `biome.json` does not fail the config — it floods.** Biome reads
  its own config with comments tolerated, then *lints the same file* as plain
  JSON, where `//` is a parse error. Measured: one comment took a clean run from
  **174 files checked, 0 findings** to **368 files, 19,978 errors, 24,897
  warnings** — because the config stops being honoured, `vcs.useIgnoreFile` with
  it, and `node_modules` gets linted. Nothing says "your config is invalid".
  Put reasoning in prose and keep `biome.json` plain, or rename it `.jsonc`.

  Note the pair, because the two behave oppositely: an **unknown rule name** is
  rejected loudly with a list of valid names (below), and a **comment** degrades
  silently into forty thousand findings. Only one of those teaches you anything.
- **Biome prints `info`-severity findings forever and exits 0.** The recommended
  preset puts `useLiteralKeys` at `info`; it reached **45 occurrences — 421 of
  `pnpm verify`'s 473 output lines** — each a bordered block with a code frame,
  and the run stayed green. `--error-on-warnings` does not catch infos. Seven of
  the 45 were added in one session by someone reading that output every few
  minutes, which is the whole problem: a rule that reports and passes is a rule
  people learn to scroll past. Either promote it to `error` or turn it off.
- **Boundary checkers must not match prose.** An early version flagged the word
  "from" inside comments and template literals. False positives are how a checker
  gets switched off.
- **`z.string().min(1).optional()` rejects an empty environment variable.**
  `.optional()` admits `undefined`; `KEY=` with nothing after it is *present* and
  equal to `""`, which fails `.min(1)`. This shipped, and it broke on the most
  ordinary action available — `.env.example` lists every credential with an empty
  value, so copying it to `.env`, or adding a placeholder line for a provider you
  have not signed up for yet, made `loadConfig` throw and took out every CLI
  command and eleven tests, naming a key the session was never going to use.
  For anything read from an environment, empty must mean absent — and trim, since
  `KEY= ` passes `.min(1)` and reaches the provider as whitespace, which comes
  back as an authentication error rather than a configuration one.
- **A provider's model-list endpoint reports what your key can SEE, not what it
  can USE.** Three Gemini ids returned by `v1beta/models` were rejected on the
  first real call with *"no longer available to new users"* — the listing is not
  a capability check. If a model id matters, call it once.
- **Zod `.default()` does not parse its argument** (see DECISIONS.md), and
  `.partial()` does not strip defaults. Both are silent data bugs.
- **A balanced brace span is not necessarily JSON.** `extractJson` first returned
  the first balanced `{…}`, which is `{curly}` in the sentence "use {curly}
  braces". Candidates must actually parse, and the longest parsing one wins —
  prose can contain `{}`, which parses fine and is never the answer.
- **A catch-all `translate()` can eat your own errors.** The vercel adapter wraps
  everything thrown inside `generate` so no vendor type escapes — including the
  `CapabilityError` its own prompted path throws, whose `retryable: true` was
  silently downgraded. Any error-translation boundary needs a pass-through for
  errors that are already translated.
- **`codec.parse(domainValue)` fails.** A codec's `.parse` expects the *wire*
  shape, so anything that stores a generated value and re-validates it later —
  cassettes, a cache, a queue — must use `schema.out`, which `ZodCodec` exposes.
  Verified in both directions.
- **Zod `.omit()` throws at *runtime* on a schema carrying refinements**, and
  `tsc` is perfectly green. `.refine()` in Zod 4 attaches a check to the same
  `ZodObject` rather than wrapping it, so `Question.omit(...)` still typechecks
  and then dies on import with *".omit() cannot be used on object schemas
  containing refinements"*. Keep an unrefined base (`QuestionShape`) for drafts to
  derive from, and put cross-field rules only on the entity.
- **`Set.add()` returns the Set, not a boolean.** `!seen.add(id)` is always false;
  a duplicate check written that way never fires.
- **Zod brands *intersect*, which makes id subtyping expressible.**
  `.brand<'OpenItem'>().brand<'RequirementId'>()` yields both brands, so a
  `RequirementId` widens to `OpenItemId` with no cast while the reverse and every
  sibling narrowing stay errors. Used in `domain/shared/ids.ts`; proved in all
  three directions with `@ts-expect-error` before adoption. Do not "simplify" it
  to a `z.string()` union — that silently loses the narrowing half.
- **An unknown key in a Zod object is *stripped*, so a renamed field makes a test
  pass vacuously.** Renaming `blockingGapIds` → `blockingItemIds` left one policy
  test parsing `blockingGapIds` into nothing: the assertion still ran, against an
  empty list, and reported the veto working when it was not being exercised at
  all. After renaming a field, grep for the old name in fixtures **and in the
  database** — the compiler will not.

  **"And in the database" was added after this lesson failed a second time.** The
  entry above said *fixtures*, so renaming `QuestionOption.commits` → `means` got
  a careful grep of the source tree — eighteen files, all correct — and no
  thought at all about the eight rows already holding the old key. Every read of
  that session then threw. The lesson was right and scoped one word too narrowly;
  see the drizzle-kit sharp edge below for why nothing caught it.
- **drizzle-kit cannot see inside a `jsonb` column, so a rename there is invisible
  to migration generation.** `jsonb('options').$type<QuestionOption[]>()` — the
  `$type<>` is a TypeScript assertion with no runtime or DDL presence. In one
  phase, two *columns* were added and one field inside a JSONB blob was renamed;
  `pnpm db:generate` produced migrations for both columns and was structurally
  silent about the rename. **Eight columns of this schema carry Zod-validated
  shapes that no schema-diffing tool will ever check.**

  The three shape changes had three different fates, and the pattern is the
  useful part:

  | Change | Seen by drizzle-kit? | Survives an old row? |
  | --- | --- | --- |
  | **add** a field | yes — it is a column | yes, migration backfills |
  | **delete** a field | n/a | yes — Zod strips unknown keys |
  | **rename** a field inside JSONB | **no** | **no** — new name required, old one ignored |

  A rename is the only change that is both undetectable by the tooling and fatal
  to the reader. Everything else degrades safely on its own, which is exactly why
  this one was the one that shipped.
- **`pnpm verify` cannot observe a row written by an older version of the code.**
  PGlite builds an empty database per suite, applies migrations to it, then writes
  and reads in the *current* shape. A migration that is correct for new rows and
  incomplete for existing ones is indistinguishable from a correct one. The only
  way to have such a row in a test is to write one deliberately —
  `postgres.test.ts` now does.
- **`unpdf` rejects a Node `Buffer`** — *"Please provide binary data as
  `Uint8Array`, rather than `Buffer`"* — even though `Buffer` extends
  `Uint8Array` and satisfies the port's type. Any caller using `fs.readFile`
  hits it. `pdf.ts` normalizes with a zero-copy view.
- **AI SDK v7 provider-level usage is nested** (`inputTokens: { total, noCache,
  … }`) while the flattened `LanguageModelUsage` on the result is not. A mock
  returning the flat shape yields zeros.

---

## A prompt that names a failure mode suppresses the behaviour near it

Measured accidentally, and worth remembering. Adding *"An `add` with an empty
`settledBySourceId` is rejected and the whole turn is lost. Never leave both
empty."* to the tier instructions dropped turn-1 decisions from **8 to 1**.
Softening the same guidance to *"settle generously when the input actually
settles something"* recovered it to **5**. Same model, same input, same schema.

Prompts are not documentation: a warning about a failure reads as a warning about
the *operation*, and the model routes around both. Prefer stating the correct
move to describing the incorrect one.
