# CLAUDE.md — @requirely/core

Requirely's brain: the domain model, the gathering engine, and the adapters behind
its ports. A **library**, not a deployable — it has no entry point. Front doors
(`apps/api`, `apps/cli`) become `apps/*` packages when they are written.

Read the root `CLAUDE.md` first for the product, the loop invariant, and the
provider-agnostic constraint. This file covers only what is true inside this package.

## Status

Phases 0–6 are done, plus Phase 7 steps 0–1 (adapter fixes, cost accounting, the
live harness and the first real model call) and **Phase 8 steps 1–3** (the domain
reshape — a settled `Decision` tier, promotion, `Gap` deleted — `src/wire/`, the
sentinel-encoded flat op list the model actually sees, three generation methods
behind one port, a sufficiency verdict that is counted rather than scored, and
projections that render the deliberation behind each decision, and durable
evals). **Phase 8 is complete.**

**Phase 7 is parked mid-flight.** The first live calls found that providers
compile strict schemas into decoding grammars and cap their branchiness, and ours
was 3× over. Phase 8 was that redesign, and it has landed. **Phase 7 steps 2–4
resume next**: the `./server` export, `apps/cli`, and the self-gathering run.

**Live cassettes are currently absent** — the Phase 7 recordings were orphaned by
the Phase 8 schema change and re-recording is blocked on the org API spend limit.
`src/integration/live.test.ts` skips loudly rather than passing vacuously.

See `docs/PLAN.md` for the full picture, `docs/DECISIONS.md` for why the
architecture is shaped this way, and `docs/WEAKNESSES.md` for what is known-wrong.
Add commands below as they land; never document a command that doesn't exist.

## Ingestion orientation

`ingestion/service.ts` is the **only** place a `Source` comes into existence. It
owns the `SourceRepository`, which is what lets it assign the session-scoped
ordinal (`src-1`, `src-2`) — previously the caller's job, and nothing computed it.

Every modality leaves the same shape behind: a `Source` whose `normalizedText` is
all the engine ever reads. Nothing downstream learns a PDF or an audio file was
involved. That is "modality is a mechanism, not an identity" made concrete.

- **Documents extract *before* persisting.** A corrupt PDF leaves no row.
- **Audio persists `pending` *first*, then transcribes, then updates.** The
  in-flight state is real and observable, so moving transcription to a job queue
  later changes the runner, not the model.
- **A failed transcription deletes its pending row.** A `pending` row is an
  in-flight marker, not a failure record — so a failure still leaves no durable
  trace. This is the only legitimate caller of `SourceRepository.remove`.
- **Ordinals may be reused after a failed ingest**, and that is safe: a `pending`
  source has no text, so `isAnalyzable()` is false, so it can never be cited in
  `provenance` and never reaches a turn. `loadSources` in `engine/loop.ts`
  enforces the premise by skipping non-analyzable sources.
- **Empty extraction is rejected**, not stored. A scanned PDF is images; storing
  it would spend a turn discovering there is nothing to read.
- **Media type comes from the file extension**, overridable. Sniffing magic bytes
  is more robust, but a `.pdf` that is secretly a ZIP is a user error worth
  surfacing rather than silently correcting.

Whisper does not diarize, so `TranscriptSegment.speakerLabel` is always null
today. The field exists so Deepgram drops in later without re-transcribing
anything already ingested.

## Storage orientation

**`runTurn` does not write.** It reads, calls models, and returns a `TurnCommit` — a Zod-validated domain command (`domain/turn/commit.ts`) carrying the session, revision, turn, questions and answers. Persisting is a separate step:

```ts
const commit = await runTurn(session, request, deps);
await stores.committer.commit(commit);
```

Why: the old loop wrote at five points interleaved with model calls, so a failed call left orphaned answers. Wrapping the loop in a transaction instead would hold a Postgres connection and row locks open across every LLM call. Splitting it keeps the transaction to milliseconds.

Consequences worth knowing:

- **`UnderstandingRepository` and `InquiryRepository` are read-only.** A revision cannot be appended without a turn to justify it — that is now enforced by the types, not by convention.
- **`TurnCommit` self-validates cross-references** (turn ↔ revision, question → turn, `turn.index === revision.revision`). An engine bug fails at the boundary instead of becoming a data problem.
- **Both adapters pass one contract suite** (`adapters/storage/storage-contract.ts`). In-memory reproduces Postgres's unique constraints by hand — without that it was silently more permissive, and the suite caught it.
- **Timestamps are `timestamptz(3)`**, converted at the mapper boundary by `toTimestamp`/`fromTimestamp` in `postgres/repositories.ts`. This was `text` at first, justified by "ISO-8601 UTC sorts correctly as text" — which is only true if every writer emits the identical canonical format, and no constraint can enforce that. Measured: text accepts `'not a date'`, orders `'…T23:00:00+05:30' > '…T18:00:00.000Z'` as `true` when the truth is `false`, and needs a `::timestamptz` cast for any temporal predicate — which defeats the index. `precision: 3` pins the column to what `Date.toISOString()` can represent, so lossless round-tripping is a schema guarantee rather than a property that holds only while our code is the sole writer.
- **Tests use PGlite** (Postgres in WASM, in-process). `docker-compose up -d` is for developing against a real server.
- `version` exists on `sessions` and is bumped on write but **not enforced**, and deliberately absent from the domain `Session`.

## Engine orientation

`runTurn` in `engine/loop.ts` is one iteration of the loop. Per turn:

1. `validateAnswer` on every answer — **before any model call**, so a malformed answer costs nothing
2. the configured strategy produces `{ understanding, delta, assessment, usage[] }`
3. `decideSufficiency` → verdict → session becomes `sufficient`, `exhausted`, or `awaiting-answers`
4. one `Turn` recorded with inputs, before/after revision ids, verdict, and per-operation usage

Load-bearing details:

- **Sufficiency is counted, not scored.** Three conditions, all read off the
  stored document: no blocking open items, every required dimension has a Decision
  behind it, and `ratio >= 0.5`. The middle one is what stops a settled ratio
  being gamed by promoting a single requirement. **Coverage cannot vote** — it
  orders questions and catches shallow decisions that counting cannot, and two
  tests pin that it can neither create nor block a verdict.
- **`stalled` is a status, not a flag.** Two turns settling nothing new, checked
  *after* `exhausted` so a turn that did both reads as "out of budget" — the half
  a user can act on by raising it. Movement counts `decisions + superseded`,
  because counting only current decisions would read a supersession as a wasted
  turn.
- **The stall counter travels on the previous turn's verdict**, read with
  `listTurns`. Phase 3 removed a `listTurns` call for `Turn.index` because that
  was derivable; this is not derivable from anything, and one small read against
  three model calls did not justify a new port method or a duplicated counter on
  `Session`.
- **`engine/context.ts` is the only place a model's input is assembled.** Token optimization (windowing, summarization, `Embedder` retrieval) lands there and nowhere else.
- **Two strategies, `REQUIRELY_TURN_STRATEGY`.** `separate` (3 calls) assesses the stored understanding; `merged` (2 calls) assesses a predicted one. The saving is exactly the compact projection's size per turn. An integration test asserts both reach the same outcome.
- **`merge` is passed _into_ strategies** rather than returning a delta to apply. Applying twice would advance the document's id counters twice; the callback makes that unexpressible, and a runtime guard catches it anyway.
- **Unknown IDs are handled asymmetrically on purpose.** `applyDelta` throws on a bad ID (one retry). `resolveBlockingItems` silently drops them, because a hallucinated blocking item would veto sufficiency forever and deadlock the session — and because promotion makes a stale id an *ordinary* outcome of the loop working.
- **`selectQuestions` no longer drops anything.** It used to require a question to name a live `Gap`, which meant a model could only ask about something it had first invented an entity for. Now a stale `about` is *cleared* and the question survives — a question about an absence is the most valuable kind on turn one.
- **Question ordering comes from `verdict.shortfalls`**, not a model-supplied priority — the same reasoning that removed `Requirement.confidence`.
- **The fake adapter validates scripted responses against the real schema.** A fixture that drifts fails exactly as a bad model response would.

Tests that wire adapters to the engine live in `src/integration/`, not `src/engine/` — the boundary rule forbids `engine/ → adapters/` with no test exemption.

## AI adapter orientation

`StructuredGenerator.generate(elicitation)` takes one object carrying the schema
and its examples. The adapter decides **how** to ask, per request.

- **Three methods, ordered by the guarantee each gives up.** `constrained` makes
  malformed output unrepresentable but caps schema branchiness; `tool` removes
  the cap and hands conformance back to us; `prompted` describes the schema in
  the prompt and parses text. `prompted` is what makes this a port rather than a
  shared spelling for two vendors that already agree.
- **`chooseMethod` is pure**, over a `SchemaBudget` and a per-provider
  `GrammarCaps`. No library does this — Instructor, BAML and the AI SDK all take
  the mode as global config, so an over-large schema fails at request time.
- **`prefersThinking` is the one non-obvious rule.** Anthropic's `jsonTool`
  forces `tool_choice`, and forced tool use rejects extended thinking — so on a
  high-effort call, `tool` would trade away the deliberation that made it
  high-effort, and `prompted` is the better step down. `effort` reaches the
  decision as a boolean, so no vendor vocabulary enters the pure function.
- **The repair ladder is conservative on purpose.** Extract → strip trailing
  commas → unwrap a single-key envelope, each rung reporting what it did.
  **Truncation is never repaired**: appending closers turns a cut-off list of
  requirements into a shorter list that looks complete.
- **`Generated.raw` is `null` outside `prompted`.** The object path has no raw
  text; re-serializing the parsed value and calling it raw would be a lie in the
  place a reader would trust it.
- **`translate()` passes a `CapabilityError` straight through.** Re-wrapping our
  own already-translated error silently downgraded `retryable: true` to false, so
  a recoverable prompted failure was never retried. Caught by a test.
- **Replay validates against `schema.out`, not `schema`.** A cassette stores the
  *domain* value, but a codec's `.parse` expects the *wire* shape — so
  `codec.parse(domainValue)` fails, and every replay would break with what looks
  like drift. `ZodCodec` exposes `.out`; `recording.ts` uses it.

## Wire orientation

`src/wire/` is what a model sees. `src/domain/` is what the system believes.
Neither is derived from the other, and a `z.codec` is the only bridge.

- **`wire/budget.ts` is the only schema measurer**, shared by the CI budget test,
  the runtime method choice and the live probes. It was three copies of one
  walker, which is three chances for them to quietly disagree about what they
  count.
- **`engine/steps.ts` passes `UnderstandingDeltaCodec` where it used to pass
  `UnderstandingDelta`.** A codec's input side is the wire and its output side is
  the domain, so the generator emits the flat schema and returns an ordinary
  domain delta. `Generated<UnderstandingDelta>` is unchanged; nothing below that
  line knows a wire exists.
- **Every field is required; `''` and `[]` mean absent.** An optional property and
  a nullable one are both grammar branches; a plain `string` is not. For enums the
  sentinel is a **member** (`z.enum(['','low'])` → one `enum`), never a union with
  a literal (`z.enum(['low']).nullable()` → an `anyOf`). Zero unions depends on
  that distinction.
- **The sentinel is unambiguous only because every field it touches is `.min(1)`
  in the domain.** Re-check that before adding a field; one where empty is
  meaningful must not use this encoding.
- **`blocking` is a three-state enum, not a boolean.** `false` cannot also mean
  "unchanged", and a revise that did not restate it would silently clear a veto.
- **`id` always names the thing an op acts on** — `''` for `add`, the item for
  `revise`/`retire`, the promoted item for `promote`. There is no separate `from`
  field: a second way to name the same thing is a second way to get it wrong.
- **Revise and retire route by the id prefix; `target` is read only for `add`.**
  The two can disagree, and throwing would cost a whole turn over a redundancy the
  wire introduced itself.
- **`decode` reports at wire paths** (`ops[3].kind`) through `ctx.issues`, so a
  failure is a `ZodError` the retry decorator can re-ask on — not a lost turn —
  and it names something in the schema the model was actually given.
- **`encode` exists for one property test**, `decode(encode(x)) ≡ x`. Nothing in
  production calls it. It is what makes adding a domain field with no wire home a
  CI failure instead of a field that silently never reaches the model.
- **Two things are deliberately not expressible**, each pinned by a test: clearing
  a nullable field through a revise (`''` already means unchanged — use retire +
  add), and clearing every user group.

## Eval orientation

`src/integration/strategy.eval.test.ts` answers *which configuration is better*;
`live.test.ts` answers *does it work against a real provider*. Different
questions, two files, one shared `live-harness.ts` so they cannot disagree about
when to skip.

- **The instrument and the readings are separate, deliberately.** An eval run
  against a fake measures the *fixture*: `answerAll` picks option zero and the
  fixture recommends index zero, so it reports 100% recommendation acceptance,
  which says nothing about anchoring. The fake half claims only that the harness
  runs and the arithmetic holds; the model half supplies numbers and skips loudly
  when it cannot.
- **`sessionMetrics` is pure over what a session already stores.** An instrument
  that needed new fields would make measuring expensive enough to skip.
- **`withMetering` exists because a `Turn` cannot carry per-call facts.**
  `Generated.method` and `Generated.repairs` never reach it, and threading them
  through `Usage`/`Turn`/the commit/both adapters would pay a schema cost forever
  for an occasional measurement. **Where you wrap it is the API**: outside
  `withValidationRetry` counts one entry per logical call; inside it counts
  attempts.
- **Two `null`s that are not zeros.** `recommendationAcceptance` is null when
  nothing was recommended (a rate over zero offers is undefined, and 0% reads as
  "always disagrees"); `repairs` is null when nothing metered them.

## Projection orientation

Every projection is a pure function of `ProjectionInput`. Nothing there is
fetched — the caller does that — which is what keeps them snapshot-testable and
unable to fail.

- **`ProjectionInput` carries `{ questions, answers }` and they are required.** A
  default of `[]` would let a caller forget and get a quietly thinner document.
  They exist to turn `Decision.settledBy` from an id into the alternatives that
  were on the table.
- **`deliberation.ts` is the join**, shared rather than repeated: Decision →
  Answer → Question → Options, plus whether a Requirely recommendation was
  overridden. Nothing is duplicated onto the `Decision` to make it work.
- **An unresolvable reference is dropped while rendering, never thrown.** An
  unknown id in a *delta* must fail the turn; the same id while rendering costs
  one absent paragraph, and throwing would cost the whole document.
- **The body renders `currentDecisions()`; Appendix A renders what is still open.**
  An early-stage session therefore produces a thin document with a long appendix,
  which is the honest shape rather than a defect.
- **The agent prompt deliberately carries rejected options**, against its own rule
  of dropping what an agent cannot act on — a rejected option is the solution
  space closing, and re-proposing one is the waste this product exists to prevent.

## Domain model orientation

`src/domain/` has no I/O and depends on nothing but `zod`. Three pure functions carry the logic:

| Function            | Location                       | Contract                                                                                                                                    |
| ------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `applyDelta`        | `understanding/apply-delta.ts` | Merges a turn's changes into the next `Understanding`. All-or-nothing: unknown IDs throw `UnknownReferenceError` rather than being skipped. |
| `decideSufficiency` | `sufficiency/policy.ts`        | Turns the model's coverage assessment into a verdict via `SufficiencyPolicy`. The model supplies evidence; this supplies the decision.      |
| `validateAnswer`    | `inquiry/validate-answer.ts`   | Relational checks an `Answer` schema cannot express, since each needs the `Question`.                                                       |

Load-bearing conventions, each with a test pinning it:

- **Nullable, not optional.** Absent values are `null`, because the domain is stored as JSONB and `undefined` disappears on serialization. `round-trip.test.ts` asserts this for every entity.
- **Drafts vs entities.** A model emits `*Draft` (no `id`, no timestamps); the domain assigns identity. Drafts are derived with `.omit({ id: true })` so they cannot drift from the entity.
- **Two tiers, and the ratio between them is the product.** `decisions[]` is what
  is settled; `requirements` / `constraints` / `assumptions` / `contradictions`
  are what is not. The loop moves items from the second to the first via
  `decisions.promote`, which creates the Decision and removes the item in one
  operation. There is **no `Gap`** — an unsettled requirement *is* the gap, and an
  absence is a `dimension` with a low score and nothing behind it.
- **Decisions are immutable, ADR-style.** Never edited, never deleted; replaced by
  adding a new one with `supersedes`, after which `applyDelta` writes
  `supersededBy` on the old record. So there is no `status` enum (proposed-vs-
  accepted *is* the tier split) and `decisions[]` grows monotonically by design.
  `currentDecisions()` filters to `supersededBy === null`.
- **Every Decision names what settled it, and the model may only cite a Source.**
  `settledBy: AnswerId | SourceId`, but an `AnswerId` is a 40-character UUIDv7 —
  the exact transcription risk Phase 3b removed. The engine derives answer-settled
  promotions from `Question.about` and passes them in `ApplyDeltaContext.settledBy`,
  where they **win** over any source the model cited. The wire slot is
  `settledBySourceId`, validated against `ctx.knownSourceIds`.
- **`OpenItemId` is a brand *supertype*, because Zod brands intersect.**
  `.brand<'OpenItem'>().brand<'RequirementId'>()` carries both, so a
  `RequirementId` widens with no cast while `OpenItemId → RequirementId` and every
  sibling narrowing stay errors. Proved in all three directions with
  `@ts-expect-error` before adoption. Do not flatten it to a `z.string()` union.
- **`retire`, not `remove`.** An item leaves its collection for two different
  reasons — it was wrong, or it was promoted — and only the first is a retirement.
- **Two id schemes, chosen by scope — not one scheme everywhere.**

  | Scope | Form | Minted by | Why |
  | --- | --- | --- | --- |
  | Inside `Understanding` (decision, requirement, constraint, assumption, contradiction) | `dec-7`, `req-1` | `applyDelta`, from `Understanding.nextIds` | No table, no PK — unique within one JSONB document is all that is needed. Short enough for a model to copy back. |
  | `Source` | `src-1` | ingestion, from a session-scoped ordinal | The one table PK a model must emit (`provenance.sourceId`). PK is `(session_id, id)`. |
  | Session, turn, revision, question, answer | `ses-01a033cb-…` (UUIDv7) | `IdGenerator` port | Never model-emitted. Keeps global uniqueness and index locality, which is what UUIDv7 is good for. |

  A 40-character UUID shared a 28-character prefix with its neighbours — UUIDv7's timestamp bits guarantee that for a batch minted in one call. Every model reference was a transcription task with an all-or-nothing failure (`applyDelta` throws), on a path costing 2–3 calls at `effort: 'high'`.
- **`Question.rationale` and `QuestionOption.means` are required.** A question
  with no stated reason is a form field; an option list without explanations is a
  menu. Both were the first fields a model would drop while they were optional.
  `means` was called `commits` and the rename is the change: "commits you to"
  read as an obligation being incurred, which is wrong for a user who does not
  yet know what they want — nothing here is binding, and `Decision.supersededBy`
  is what makes that true. A sibling `elaboration` field was deleted outright: it
  was nullable, set by two fixtures, rendered by nothing and **named in no
  prompt**, so no model ever filled it. A field no prompt mentions does not
  exist, and this one cost a union slot against the grammar caps to not exist.
- **`recommends` is an `OptionId` on the entity and an *index* on the draft.**
  Option ids are minted by `materializeQuestions`, so a model cannot name one.
  `because` is required exactly when `recommends` is, and `recommends` must name
  one of the question's own options — both enforced by refinements on `Question`.
- **`Question` is `QuestionShape` plus refinements, and the split is load-bearing.**
  Zod 4's `.omit()` throws at *runtime* on a schema carrying refinements while
  `tsc` stays green, so drafts derive from the unrefined `QuestionShape`. Never
  add a cross-field rule to the shape.
- **`Understanding.nextIds` is a monotonic counter, not `max + 1`.** Retirement *and promotion* both make `max` non-monotonic; reissuing `req-3` would silently repoint a `Question` from an earlier turn that still stores `about: 'req-3'`, and would collide with a `Decision.promotedFrom` still naming the original. Pinned by a test.
- **`applyDelta` takes no `IdGenerator`.** It is a function of `(understanding, delta)` plus an optional `{ resolvedBy }` map — more deterministic than before, not less.
- **Nothing on the wire carries an `AnswerId`.** The engine derives item → answer (`Question.about`, `Answer.questionId`) and passes it in. Eliminating a model reference beats shortening one; look for that before reaching for handles or enums.
- **`.prefault()`, not `.default()`, for nested objects.** Zod's `.default()` returns its argument _without parsing it_, so `.default({})` yields a bare `{}` and skips every inner default. `.prefault({})` parses first.
- **Revisions strip defaults.** `patchOf()` in `understanding/delta.ts` — `.partial()` alone leaves `.default()` intact, so a revision naming one field would silently overwrite the others with their defaults.
- **Unmentioned means unchanged; `null` means cleared.** `stripUndefined` in `apply-delta.ts` enforces this.

## Temperament orientation

Five numeric dials on the `Session` — `creativity`, `assertiveness`,
`technicality`, `thoroughness`, `curiosity` — that decide how Requirely works on
one session. `domain/temperament/` holds the value object and two pure
derivations; nothing else in the domain knows they exist.

- **Numbers, not modes.** The two personas that motivated this differ on
  `technicality` and agree on everything else, which is an argument an enum
  cannot make. Presets (`explorer`, `translator`, `scribe`, `balanced`) are
  starting points, and an individual dial overrides one.
- **`DIAL_NAMES` derives from `Temperament.shape`.** A hand-written union would
  compile while silently omitting a dial from every briefing that iterates it —
  the dial would exist, be settable, be stored, and do nothing.
- **Three wirings, and one deliberately absent.** Graded prose (banded in thirds,
  because prose cannot be interpolated), scaled counts (continuous), and the raw
  number stated in the prompt. **Not** the provider's sampling temperature: it
  would move with the other three, so no experiment could attribute an effect to
  any of them.
- **A dial may never raise a ceiling.** `countsFor` clamps `questionsPerTurn`
  against `config.maxQuestionsPerTurn` rather than replacing it, and `policyFor`
  derives from a base so `requiredDimensions` survives — a slider must not be
  able to redefine what "understood" means.
- **`runTurn` reads the dials off the session, not off `EngineDeps`.** That is
  what makes per-request dials additive later: one line becomes
  `request.temperament ?? session.temperament`. `Turn` records what it ran under,
  so changing dials mid-session cannot rewrite history.
- **The briefing is appended to the prompt, never prepended**, so the stable body
  stays a shared cache prefix. `engine/prompts.test.ts` pins that, and pins the
  placebo property: every dial must produce different instructions when moved
  alone. That test is not paranoia — this prompt file carried "You are not a
  question-asking machine" twice, top and bottom, and the questions stayed
  interrogatory. **Prompt pleading loses to structural incentive.**
- **The old conservatism survives as the bottom band**, not as a deletion.
  `scribe` still gets "an assumption is a last resort"; it just is not everyone's
  only option any more. What made removing it safe is that the two-tier model
  already prevents fabrication — an open item gets a question, an assumption
  carries a checkable `basis` — so the blanket rule was belt-and-braces over a
  structural guarantee.

## Commands

Run these from the repo root (they delegate here) or from `packages/core` directly.

```bash
pnpm --filter @requirely/core run typecheck    # tsc --noEmit
pnpm --filter @requirely/core run boundaries   # this package's six rules
pnpm --filter @requirely/core run node-runnable # prove `node` can still execute src/
pnpm --filter @requirely/core run test         # vitest run
pnpm --filter @requirely/core run test:watch

pnpm db:generate   # regenerate migrations from schema.ts — review the SQL diff
pnpm db:migrate    # apply migrations to DATABASE_URL
pnpm db:studio     # drizzle studio

# a single test file
pnpm --filter @requirely/core exec vitest run src/config/env.test.ts
```

## cwd is load-bearing here — but less than it was

Two paths still resolve against `process.cwd()`, so **any process touching those must run
with `cwd = packages/core`**. `pnpm --filter` guarantees that; nothing else does.

| Path | Where | Status |
| --- | --- | --- |
| `schema: './src/…/schema.ts'`, `out: './drizzle'` | `drizzle.config.ts` | still cwd-relative |
| `loadEnvFile(path = '.env')` | `src/config/env.ts` | still cwd-relative, and it **swallows a missing file**, so a mis-pathed `.env` is indistinguishable from an absent one |
| ~~`migrationsFolder: './drizzle'`~~ | `postgres/client.ts`, `postgres/testing.ts` | **fixed in Phase 7** — both read `MIGRATIONS_FOLDER` from `postgres/migrations.ts`, resolved with `import.meta.dirname` |

The migrations fix is the prediction in this file coming true: *"the first server-side consumer
not launched from this directory will hit this for real"* — the CLI was that consumer, and
running it from `apps/cli` would have looked for `apps/cli/drizzle`, found nothing, and either
migrated zero tables or failed with a path the user has no reason to recognise. Verified from a
foreign cwd: `cd /tmp && node -e "import(…/migrations.ts)"` resolves to
`packages/core/drizzle`.

Consequences that remain:

- **Root `db:*` scripts are `--filter` delegations, never direct invocations.** A root
  `drizzle-kit generate` would write `out: './drizzle'` to the repo root, creating a second,
  divergent migration history while the real one sits untouched.
- **`loadEnvFile()` does not find the root `.env`.** With no argument it looks in
  `packages/core`. Entry points should pass an explicit module-relative path — they are the only
  code that knows where they sit. `apps/cli` does exactly that.
- **vitest config is still per-package**, but the *reason* has changed. It used to be that a
  root-level run would resolve `./drizzle` to the repo root and fail every PGlite test inside
  `migrate()`; that specific failure is gone. What remains is ordinary per-package config
  ownership. Do not treat "we could now move it" as "we should" without re-measuring — Vitest 4
  still does not `chdir` per project.

## Toolchain constraints worth knowing before writing code

- **Node 24 runs `.ts` directly** via type stripping, so relative imports must carry the
  `.ts` extension (`import { x } from './x.ts'`). Precisely: **only *value* imports are
  enforced by Node.** An `import type` specifier is erased before resolution, so Node never
  looks at it and an extensionless one runs fine — `tsc` (TS2835) is the *only* gate that
  catches those. Verified both directions 2026-08-20. Write the extension everywhere
  anyway; the point is knowing which gate is protecting you.
- **Only erasable TypeScript compiles** (`erasableSyntaxOnly`): no `enum`, no constructor
  parameter properties, no `namespace`. Use `as const` objects with a derived union type
  instead of `enum`, and assign class fields in the constructor body.
  **This flag is a runtime constraint, not a style preference.** Measured: a file with
  `export enum X {}` passes `vitest` 9/9 — vitest transpiles with its own pipeline — and
  dies under `node` with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, a third error code beyond the
  two named elsewhere in this file. Weakening or dropping the flag would be a silent
  runtime regression with a fully green test suite. `pnpm node-runnable` is the backstop.
- `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on. Optional fields that
  can genuinely be absent are declared `foo: T | undefined`, not `foo?: T`.
- These three live in `packages/core/tsconfig.json`, **not** in the root
  `tsconfig.base.json`, because each is a claim about Node's type-stripping runtime and
  would be actively wrong for a bundled React package. The base carries strictness only.

## Enforced architectural boundaries

Three gates run over this package. Two enforce the provider-agnostic constraint, because a
rule that lives only in prose decays silently:

- `pnpm boundaries` (`scripts/check-boundaries.sh`) — the CI gate. Nine `report()` calls
  covering six documented rules (the domain third-party rule is two checks — production
  files, and test files which may additionally use `vitest` — and rule 6 is three:
  `wire/ → domain/` only, `wire/` third-party, and `domain/ ↛ wire/`).
- Biome `noRestrictedImports`, scoped per-directory in `biome.json` `overrides` — the
  editor gate, for feedback while typing.

The third, `pnpm node-runnable` (`scripts/check-node-runnable.sh`), enforces something no
grep can express — see "Source-only, and the one thing that breaks it" below. It is a
separate script rather than two more `report()` calls in `check-boundaries.sh` because
those rules are all greps over source text, while these two observe the install topology
and Node's parser. Its five failure paths were each proven by planting a violation:
non-erasable syntax, an extensionless value import, a realpath under `node_modules`, a
wrong cwd (abort guard), and a `find` matching zero files (vacuous-pass guard).

The rules: `domain/` imports no outer layer and no third-party package but `zod` (test
files may add `vitest`); `engine/` imports neither `adapters/` nor `app/`; **`ai` and
`@ai-sdk/*` may only be imported under `src/adapters/ai/`**; and `Date.now()`,
`new Date()`, `crypto.randomUUID()`, `Math.random()` appear nowhere in `domain/` or
`engine/` — time and identity enter only through the `Clock` and `IdGenerator` ports.

After changing the script, re-prove it by planting deliberate violations and confirming
each rule fires. An earlier version matched the word "from" inside comments and template
literals; false positives are how a checker gets switched off.

Three properties of the script that are load-bearing:

- **`cd "$(dirname "$0")/.."` on line 11** is why moving this package cost the script a
  zero-line diff. Keep it; never hard-code a repo-root path.
- **An abort guard** now fails loudly if `src/domain` and `src/engine` are absent. Both
  helpers return silently on a missing directory — correct for `src/app`, which does not
  exist yet, but it meant a wrong cwd printed "Boundary check passed" while checking
  nothing.
- **Rule 4 matches `@requirely/core/…` as well as `../`.** Adding an `exports` map made
  the package self-referenceable, so `from '@requirely/core/adapters/…'` inside `engine/`
  would otherwise have passed both the script and Biome.

## The `exports` map has exactly two entries

```json
"exports": {
  "./domain": "./src/domain/index.ts",
  "./server": "./src/server.ts"
}
```

**`./server` is a manifest, not a runtime.** It contains re-exports and nothing
else, enforced by `check-boundaries.sh` rule 7 — two checks, because one was
gameable: an allowlist over lines (precise, but has to tolerate multi-line
`export { … } from`) plus a denylist over declaration keywords (imprecise, but
cannot be slipped past by reformatting). A `createRuntime` written across four
lines is caught by the first; the same thing on one line is caught only by the
second.

There is deliberately no `createRuntime()` and no `src/app/` for one to live in.
Core exports **pieces and contracts**; each app owns exactly one composition
root. A library that knows how to assemble itself knows about its applications,
and would grow flags — or split into `createRuntimeForCLI` /
`createRuntimeForServer` — the moment a second app appeared.

`adapters/registry.ts` is the one exception to "apps do the wiring", and the line
is worth knowing: it maps the **config enum** to factories, which is a fact about
*this package's schema* and changes when a provider is added, never when an app
is. Typed as `Record<ReasoningProvider, …>` so a missing provider fails to
compile — proved by removing one. `TRANSCRIPTION_ADAPTERS` is typed
`Record<Exclude<TranscriptionProvider, 'none'>, …>`, which states in the type
that `none` is a *refusal* rather than a transcriber that returns nothing.

`src/domain/` depends on nothing but `zod` and has no `node:` imports, so it is
**isomorphic** — safe to bundle into a browser. `engine/`, `adapters/`, `config/` and
`ingestion/` are Node-only.

**The absence of a `"."` export is load-bearing.** It would let `apps/web` write
`import … from '@requirely/core'`, which is both a naming lie (the package is not the
domain) and a specifier that `scripts/check-frontend-boundaries.sh` rule 8 would reject —
a bare `@requirely/core` matches its denylist and misses the `/domain$` exemption.

**The map is enforcing more than the boundary scripts are credited for.** `adapters/`,
`engine/` and `config/` are not exported at all, so Node hard-errors
`ERR_PACKAGE_PATH_NOT_EXPORTED` on `@requirely/core/adapters/…` before any lint runs. The
widened rule-4 regex is belt-and-braces for typecheck time and for when more subpaths land.

**Self-reference already works off any `exports` key, not just `"."`.** Verified:
`src/engine/*.ts` can write `from '@requirely/core/domain'` today, from any depth. That is
exactly why rule 4 matches `@requirely/core/…` as well as `../` — the old regex required a
leading `../` and would have waved the package-name form straight through.

Verified 2026-08-19: `apps/web` importing `@requirely/core/domain` typechecks, builds and
executes at prerender time under Turbopack, **without** a `transpilePackages` entry for
core. Two corrections to how that was first written up:

- TypeScript resolves an `exports`-map target that is a `.ts` file with **no compiler flag
  at all**. `allowImportingTsExtensions` only governs `.ts` specifiers written in *source
  text*.
- So the flag is needed in a consumer only when **core's own internal imports** enter that
  consumer's `tsc` program, which happens because there are no project references. It has
  been removed from `apps/web` until core is actually a dependency there; TS5097 names the
  flag in its own message, so re-adding it is self-evident.

## Source-only, and the one thing that breaks it

**Node refuses to type-strip any file whose *realpath* is under `node_modules`**
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). This package is Node-runnable only because
pnpm symlinks it and Node resolves through to `packages/core`, which is outside
`node_modules`. That is load-bearing and it is not expressed in any config.

```
$ cd apps/web && node -e "import('@requirely/ui/lib/utils')"                     → OK
$ cd apps/web && node --preserve-symlinks -e "import('@requirely/ui/lib/utils')"
  ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
```

**This package really is Node-runnable today, not merely in principle.** Verified
2026-08-20 on Node 24.19: all **49** non-test modules under `src/` — including
`engine/loop.ts`, `adapters/storage/postgres/client.ts` and `config/env.ts`, not just the
zod-only domain — import cleanly in one `node` process. `pnpm node-runnable`
(`scripts/check-node-runnable.sh`) asserts it on every `pnpm verify`, so this is now a
gate rather than a belief. It cost ~0.7s.

### What actually breaks it — measured, not reasoned

Re-measured 2026-08-20 on pnpm 11.20.0. The earlier list in this file was wrong in two
places; this table replaces it.

| Route | Result | Type stripping |
| --- | --- | --- |
| `--preserve-symlinks` | realpath stays inside `node_modules` | ✗ `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` |
| `cp -r` into a consumer's `node_modules` (Docker `COPY`, `npm publish`) | realpath is real | ✗ same |
| `pnpm deploy` (default) | **refuses to run**: `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE` | n/a — never gets that far |
| `pnpm deploy --legacy`, deploying **core itself** | core lands at the deploy *root* | ✓ works, all 4 entries |
| `pnpm deploy --legacy`, deploying an **app** | dep symlinked back to the original checkout by absolute path | ✓ locally — but the output is **not self-contained**; copy or containerize it and the link dangles |
| `pnpm deploy` + `injectWorkspacePackages: true`, deploying an **app** | dep **copied** to `out/node_modules/.pnpm/@requirely+ui@file+…/` | ✗ `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` |
| `nodeLinker: hoisted` | workspace links stay symlinks to the source tree | ✓ works — the old claim that this breaks it was **false** |

So the break needs a specific conjunction: **an app that consumes this package, deployed
on the injected path.** That is precisely the route pnpm's own error message pushes you
toward, which is what makes it dangerous — and it is invisible in the other three deploy
shapes, so "we deployed fine last time" proves nothing.

There is **no flag-level escape hatch.** `--experimental-strip-types` and
`--experimental-transform-types` both still fail; `--no-experimental-strip-types` only
downgrades the error to `ERR_UNKNOWN_FILE_EXTENSION`.

At **runtime**, not build time. `apps/web` is immune because Next bundles rather than
strips.

**Decision (2026-08-20): bundle the app; do not add emit here.** The two options were
being presented as equivalent and the measurements say they are not. Bundling `apps/api`
(normal for Hono, and what `apps/web` already does) costs nothing today, produces a
self-contained artifact, and makes the entire realpath class of problem stop existing —
including the injected-deploy trap above, which no amount of care in *this* package can
prevent. Adding emit permanently splits "the source" from "the artifact", reopens the
`allowImportingTsExtensions` question in every consumer, and buys nothing while every
deployable is bundled. Revisit only if something must consume core **unbundled** under
Node — publishing to a registry, or a consumer that cannot run a bundler.

**Trigger.** If that day comes, the delta is config-only, no source changes:

```
tsconfig:   noEmit → false; add declaration: true, outDir: "dist", rootDir: "src"
            KEEP allowImportingTsExtensions — legal alongside emit because
            rewriteRelativeImportExtensions satisfies TS5096
exports:    "./domain" → { "types":   "./dist/domain/index.d.ts",
                           "default": "./dist/domain/index.js" }
.gitignore: dist/
```

Emit rewrites `./answer.ts` → `./answer.js` in **both** the `.js` and the `.d.ts`, so the
output is self-consistent. Dropping `noEmit` also unlocks TS project references, since
`composite` conflicts with `noEmit` rather than with emitting — which would stop consumers
typechecking core's source at all.

**Do not reach for conditional exports** (source to bundlers, `dist` to Node). The moment
`tsc` follows the source condition, core's `.ts` specifiers re-enter the consumer's program
and `allowImportingTsExtensions` comes straight back — it does not solve the problem it
exists for. It also splits module identity across two copies, which breaks `instanceof` on
the error classes in `domain/shared/errors.ts`.

## Note on `biome.json`

Later `overrides` entries **replace** earlier ones for the same rule rather than merging,
so each override repeats the AI-SDK patterns. Reordering or de-duplicating them will
silently disable enforcement — verify with a deliberate violation after any change.

All three overrides live in *this* file rather than the root config. That is deliberate:
whether Biome's `extends` concatenates or replaces the parent's `overrides` array is not
determinable from the shipped schema, and with every override in one file the answer
cannot matter. Do not split them across the two configs for tidiness.

Verified 2026-08-19: nested `overrides.includes` globs resolve relative to **this file's
directory** (`src/domain/**` matches, no `**/`-prefix needed), a root `biome check .`
discovers this config, and the inherited `vcs.useIgnoreFile` reaches the repo-root
`.gitignore`.
