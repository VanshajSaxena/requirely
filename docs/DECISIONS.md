# Decisions, and the evidence behind them

Why the architecture is shaped as it is. Several entries record a decision that
was made, **measured, and then reversed** — those are the most useful ones, and
they are kept rather than tidied away.

---

## Stack

TypeScript 7 (Go-native compiler) on Node 24 LTS, pnpm workspace. Zod 4 for every
schema. Vitest 4, Biome 2. Postgres + Drizzle. AI SDK `ai@7` behind our own ports.

**Node 24 type-stripping is load-bearing, not a convenience.** It means only
*erasable* TypeScript compiles: no `enum`, no constructor parameter properties,
no `namespace`. `erasableSyntaxOnly` in tsconfig enforces it, and
`pnpm node-runnable` proves Node can still execute the package — `pnpm test`
passing is *not* evidence of that, because Vitest transpiles with its own
pipeline and happily runs an `enum` that Node rejects at runtime.

---

## The AI abstraction

**Own ports; the AI SDK lives inside adapters only.** The SDK is already
provider-agnostic across ~14 vendors, which makes it tempting to use directly.
That would just relocate the leak: its `LanguageModel` / `ModelMessage` types
would become the domain vocabulary. Keeping it inside `adapters/ai/` means both
the provider *and* the abstraction stay swappable. Enforced: `ai` / `@ai-sdk/*`
may only be imported under `adapters/ai/`, and that is a CI rule.

**`effort: 'low' | 'medium' | 'high'` is a domain concept**, mapped per adapter.
Phase 4 tested that claim: Anthropic spends it as an extended-thinking token
budget, OpenAI as a named `reasoningEffort` level. Two different spellings,
neither reaching the engine — which is what a real port looks like.

**Every port returns `Usage`, tagged with `operation`.** Capturing cost at the
capability boundary rather than at call sites is what makes "assess was 40% of
this session's spend" answerable without touching engine code. It later paid out
a second time: because each retry attempt is its own call, a turn whose `usage`
array holds more entries than it made operations is visibly a turn that retried —
retry observability with no new field.

---

## The Understanding

**Versioned JSONB snapshots, produced by applying a delta** — not by regenerating
the document each turn.

Full regeneration works fine for three turns. By turn eight the model is
rewriting forty requirements from a growing context, details evaporate, and you
cannot tell because there is no diff. Deltas keep requirement ids stable (so
provenance survives), make each turn's effect inspectable, and hold per-turn
token cost flat instead of proportional to document size.

The cost is a real merge function — `applyDelta`, pure and exhaustively tested.

**The model produces evidence; the domain produces decisions.** The model scores
coverage per dimension and names blocking gaps; `decideSufficiency` applies an
explicit `SufficiencyPolicy` to get the boolean. Raising the bar is changing a
number, not editing a prompt and re-evaluating everything.

**`sufficient` and `budgetExhausted` are independent.** Running out of questions
must never manufacture sufficiency — that is the difference between a finished
spec and one with stated unknowns.

---

## Storage

**`runTurn` returns a `TurnCommit`; a separate `commit()` writes it.**

The original loop wrote at five points interleaved with model calls, so a failed
call left orphaned answers — a live bug, not a hypothetical. The conventional fix
is a `withTransaction` wrapper, which would hold a Postgres connection and its row
locks open across three LLM calls. Splitting compute from commit keeps the
transaction to milliseconds. Atomicity is almost a side effect of putting the
boundary in the right place.

Consequence: `UnderstandingRepository` and `InquiryRepository` became **read-only**.
Appending a revision without a turn to justify it is now unexpressible.

**One contract suite, two adapters.** `storage-contract.ts` runs against both
in-memory and PGlite. It earned itself on the first run: PGlite passed all 16, the
in-memory adapter failed the atomicity test because `Map.set` silently overwrote
where Postgres rejected a duplicate key. The fake was *more permissive than
production*. It now reproduces those constraints by hand.

---

## Two decisions that were measured and reversed

### `text` → `timestamptz(3)`

Timestamps were first stored as `text`, justified by "the domain holds ISO-8601
strings and `timestamptz` reintroduces a precision question". That argument
borrowed the authority of a real invariant (nullable-not-optional, which exists
because `undefined` genuinely vanishes in JSON) and applied it where the mechanism
does not transfer.

Measured in PGlite, 20k rows, both columns indexed:

| Check | `text` | `timestamptz` |
| --- | --- | --- |
| `WHERE col > now() - interval '7 days'` | **Seq Scan** (cast defeats the index) | **Index Only Scan** |
| `INSERT 'not a date'` | **accepted** | rejected |
| `'…T23:00:00+05:30' > '…T18:00:00.000Z'` | **`true`** — wrong | `false` — correct |
| Index / column size | 984 kB / 25 B | 456 kB / 8 B |

The ordering result decided it. "ISO-8601 UTC sorts correctly as text" hides a
precondition — *every writer must emit the identical canonical format* — and that
is precisely what a database is for.

`precision: 3` is the salvaged half of the original bad argument: it pins the
column to what `Date.toISOString()` can represent, so lossless round-tripping is a
schema guarantee rather than something true only while our code is the sole writer.

### UUIDv7 ids → short, scope-matched ids

Ids were `req_01a0148f-aca4-724e-bcb5-50201e28a940` — 40 characters, and because
UUIDv7's leading bits are a millisecond timestamp, a batch minted in one call
shared a ~28-character prefix. The property that made UUIDv7 right for *database*
locality is what made them impossible for a model to discriminate.

**The structural finding:** five of the seven model-emitted id types are not
primary keys at all. Requirements, constraints, assumptions, contradictions and
gaps live inside `understanding_revisions.content` as JSONB. Global uniqueness
bought nothing there.

Now:

| Scope | Form | Minted by |
| --- | --- | --- |
| Inside `Understanding` | `req-1`, `gap-3` | `applyDelta`, from `Understanding.nextIds` |
| `Source` | `src-1` | ingestion; PK is `(session_id, id)` |
| Session, turn, revision, question, answer | `ses-01a0…` UUIDv7 | `IdGenerator` port — never model-emitted |

`nextIds` is a **monotonic counter, not `max + 1`**: removal makes `max`
non-monotonic, and reissuing `gap-3` would silently repoint a `Question` from an
earlier turn that still stores that id.

Two things fell out. `applyDelta` no longer needs the `IdGenerator` port at all —
it is a function of `(understanding, delta)`, *more* deterministic than before.
And `GapResolution` lost `resolvedByAnswerId` entirely, because questions are 1:1
with gaps and answers 1:1 with questions, so the engine derives it. **Eliminating
a model reference beats shortening one** — look for that before reaching for
handles or enums.

Bonus: `req-1` uppercases directly into an SRS's `REQ-1`, so Phase 6 needs no
numbering scheme of its own. This change *removed* future work.

---

## Conventions with a test pinning each

- **Nullable, not optional.** `undefined` disappears through JSONB.
  `round-trip.test.ts` asserts byte-identical round-tripping for every entity.
- **Drafts vs entities.** A model emits `*Draft` (no id, no timestamps), derived
  with `.omit({ id: true })` so they cannot drift.
- **`.prefault({})`, not `.default({})`, for nested objects.** Zod's `.default()`
  returns its argument *without parsing it*, so `.default({})` yields a bare `{}`
  and skips every inner default. A silent data bug.
- **Revision schemas strip defaults** (`patchOf()` in `delta.ts`). `.partial()`
  alone leaves `.default()` intact, so a revision naming one field would silently
  overwrite the rest with their defaults. Invisible to the compiler; caught only
  because three tests asserted *preservation*.
- **Unmentioned means unchanged; `null` means cleared** (`stripUndefined`).
- **Unknown ids are handled asymmetrically on purpose.** `applyDelta` throws;
  `resolveBlockingGaps` and `selectQuestions` silently drop. A bad delta costs one
  retry, but a phantom blocking gap would veto sufficiency forever and deadlock
  the session. The deciding question is blast radius, not consistency.

---

## Projections

**Pure functions over a stored revision.** No model call. The `Understanding`
already holds every requirement, constraint, assumption, gap and citation, so
rendering is formatting. Free, instant, unit-testable, and unable to invent a
requirement that was never captured. If a projection ever *needs* to generate
prose, that means the Understanding was thin and the fix belongs upstream in the
engine.

**`sources` is passed in, not fetched.** Source labels live in the repository,
not in the `Understanding`. A projection that fetched them would be the first
thing in this layer able to fail, and impossible to snapshot-test.

**Citations name a source; they never quote it.** `Provenance.quote` is
unverified (WEAKNESSES.md #1), and a specification is where a fabricated
quotation would look most authoritative. `[src-1]` keeps traceability without
printing text nothing has confirmed. Quotes switch on in `citations.ts` alone
once verification exists.

**Standard SRS headings, empty sections omitted.** `section()` drops an empty
body and `group()` drops a parent whose children are all empty, so "omit what we
have no data for" is a property of the renderer rather than a conditional
repeated at twenty call sites.

**Honesty is unconditional.** Gaps and unresolved contradictions render whenever
they exist — not only when the session ran out of questions. `sufficient` means
every *required* dimension cleared the bar; other gaps can still be open, and
hiding them would make the most confident-looking document the least honest one.

**The agent prompt is a different genre, not a reskin.** It drops citations an
agent cannot follow, states assumptions as decisions it is *inheriting*, and
renders open gaps as an instruction to stop and ask. Handing a coding agent an
under-specified brief is the exact failure this product exists to prevent.

## Patterns worth reusing

- **Pass the mutator in, don't return the mutation.** `runTurn` hands `merge` to
  the strategy rather than returning a delta to apply. Applying twice would
  advance the id counters twice; a callback makes that unexpressible.
- **Make the fake enforce the real contract.** The fake adapter validates scripted
  responses against the same schema and marks failures `retryable`, so it stands
  in for a real provider — including for testing the retry decorator.
- **One contract, many implementations.** Separate tests drift; one suite does not.
- **Build both options and measure** when the trade is quantitative. The
  `separate` vs `merged` turn strategies exist behind a config flag for exactly
  this; measuring showed the saving was ~4%, not the ~30% estimated.
- **Eliminate > constrain > shorten > repair**, in that order, whenever a model
  has to reference something.
