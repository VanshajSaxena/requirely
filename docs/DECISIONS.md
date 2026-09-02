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
this session's spend" answerable without touching engine code. A corollary claimed here for two phases —
that a retried turn was visible from its `usage` array holding extra entries —
was **false**, and Phase 7 removed it: a failed attempt throws, so its usage died
with the exception and every retried turn under-reported its own cost. The port
was right; the free-observability bonus was imagined. `CapabilityError` now
carries the failed attempt's usage and `withValidationRetry` folds it in.

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

### Two tiers: settled `Decision`s and open items (Phase 8)

**`Decision` is the settled tier; requirements, constraints, assumptions and
contradictions are the uncertain one.** The loop's job is to move items from the
second to the first, and the design goal is stated as a direction rather than a
threshold: *always move towards more Decisions than uncertain items.*

**`Gap` was deleted.** An unsettled requirement *is* the gap, so a separate
collection was double-bookkeeping — and it forced a model to invent a `Gap`
entity before it could ask about an absence. `dimension` moved onto the uncertain
items, where it is a **lens** rather than a verdict: "nobody has said how success
is measured" is now the `acceptance` dimension scoring low with nothing behind
it, which needs no entity at all.

**Decisions are immutable, following the ADR rule.** A decision is never edited
to flip its content and never deleted; a new one is written and the old is marked
`supersededBy`. Three consequences, each deliberate:

- `decisions[]` grows monotonically. That is weakness #6 reintroduced *as a
  commitment* — the trail of supersessions is the architectural history.
- **There is no `status` enum.** Nygard's Proposed/Accepted/Deprecated/Superseded
  vocabulary is already covered: proposed-vs-accepted *is* the two-tier split,
  and superseded is `supersededBy !== null`. One durable reference beats a tag.
- `supersededBy` points **forward**, set on the old record, so "is this current?"
  is a field read rather than a scan of every other decision.

**Rejected options are derived, never copied.** MADR's most valuable section is
*Considered Options with pros and cons* — the "why not X?" an SRS otherwise never
answers. `settledBy → Answer → Question → options` reaches it, so duplicating
them onto the Decision would denormalise what a reference already gets for free.

**Anything referenced outside an entity is a durable id, never a tag.**
`settledBy: 'user'` is a stringly-typed pointer at nothing; `settledBy: ans-2` is
auditable and query-able, which is what multi-user needs later. And the model may
only ever *emit* the Source half: `AnswerId` is a 40-character UUIDv7, and asking
a model to transcribe one is the failure Phase 3b removed. The engine derives
answer-settled promotions from `Question.about` instead.

**`Contradiction.resolution` was deleted.** Resolving a contradiction *is*
deciding which side holds, which is a promotion. A `resolution` string alongside
would be a second way to record the same event — and the one that is not
auditable.

**`Assumption` stays**, controlled by prompting rather than by modelling.
ISO/IEC/IEEE 29148 treats assumptions, constraints and requirements as *distinct*
information items in an SRS, so this is standards-aligned rather than merely
tolerated. The prompt names an assumption a last resort; the eval suite measures
assumptions-per-turn, because "is this assumption warranted?" is not
structurally checkable.

**QOC's `Criteria` are deliberately not modelled.** QOC compares options against
reusable named criteria; we compare them by what each one commits you to.
Criteria are the part of QOC that most obviously adds capture burden, and capture
burden is the documented reason IBIS and QOC failed to be adopted.

---

### Sufficiency is counted, not scored (Phase 8)

**The verdict used to be a model grading its own homework.** It took per-dimension
coverage scores from the same model whose work was being judged, compared them to
a threshold, and believed the result — unfalsifiable in the direction that
flatters. What decides now is counted from the stored document:

1. **No blocking open items.**
2. **Every required dimension has at least one current Decision behind it.**
3. **More Decisions than uncertain items** — `ratio >= 0.5`, which is the owner's
   stated goal written as a number.

**Condition 2 is the one that is easy to miss and load-bearing.** A settled
*ratio* alone is gameable: promote your single requirement and you are at 100%
after turn one. Requiring a Decision per dimension cannot be gamed that way, and
it is what "dimensions survive as a lens" actually buys — the dimension becomes
how the decisions are *sliced*, not a number a model invents about itself.

**Coverage keeps a job, but a demoted one.** It no longer votes. It orders the
next questions, and it catches what counting cannot: a dimension can hold one
*shallow* Decision — "users: product managers" settles nothing about their needs
— and a model scoring `users: 0.3` sees that where a count of 1 does not. So
`shortfalls` is ordered structurally first (no Decision at all) and by coverage
score second. Structure decides the band; the model breaks ties inside it.

**Stalling is a status, not just a flag.** Two turns settling nothing new means
`stalled` — distinct from `exhausted`, and the distinction is the only part a
user can act on: one says *"give me a bigger budget"*, the other says *"the
questions are not landing, give me better input"*. Both finalize, because the one
rule `finalized` enforces is that a verdict was recorded.

Movement is measured as `decisions + superseded`, which is monotonic by
construction because Decisions are never deleted. Counting only current decisions
would read a **supersession** — correcting something wrong — as a turn that did
nothing.

### Questions carry their reasoning (Phase 8)

Requirely is not a question-asking machine, and three schema changes make that
structural rather than aspirational:

- **`Question.rationale` is required**, where it was nullable. A question with no
  stated reason is a form field, and an optional field is the first thing a model
  drops under output pressure.
- **`QuestionOption.commits` is required.** An option list without consequences is
  a menu; with them it is a decision aid. This is also what QOC's *Criteria* would
  have provided — options are compared by what each one costs you rather than
  against a shared reusable axis, because criteria are the part of QOC that most
  obviously adds capture burden, and burden is the documented reason it was not
  adopted.
- **`recommends` / `because` are separate fields precisely so a UI can withhold
  them.** Pre-selecting an option anchors — one clinical survey found 88% of
  residents had encountered the effect from AI decision support — so a surface can
  show the choice first and the opinion second, or not at all. Choosing against
  the recommendation is an ordinary answer that nothing in the domain penalises,
  and the eval suite tracks acceptance rate because a suspiciously high one is the
  signal that Requirely stopped offering a choice and started making it.

`QuestionOption.settles` earns its place by being read: the engine unions it with
`Question.about` when building the settlement map, so one question can close
different items depending on which options were chosen — and an option nobody
picked settles nothing.

**On the draft, `recommends` is an *index*.** Option ids are minted by
`materializeQuestions`, so a model cannot name one; it points at a position in its
own list and the domain translates it. Same rule that split drafts from entities
in Phase 1.

---

**The model produces evidence; the domain produces decisions.** The model scores
coverage per dimension and names blocking open items; `decideSufficiency` applies
an explicit `SufficiencyPolicy`. Raising the bar is changing a number, not
editing a prompt and re-evaluating everything.

**`sufficient` and `budgetExhausted` are independent.** Running out of questions
must never manufacture sufficiency — that is the difference between a finished
spec and one with stated unknowns.

### The wire is a separate shape from the domain (Phase 8)

**`src/wire/` sits between the domain and every model, and the domain never
crosses it.** Providers compile a strict JSON Schema into a decoding grammar and
cap its branchiness — Anthropic at 24 optional properties and 16 union-typed
ones, *per request*. `UnderstandingDelta` is assembled out of domain schemas, so
every `.default()`, `.nullable()` and `.optional()` became a branch: 84 and 34.
Shrinking the domain to fit a vendor's compiler would be letting the wire dictate
the model.

Three choices, each measured:

| Shape | optional | union | size |
| --- | ---: | ---: | ---: |
| `UnderstandingDelta` (domain) | 84 | 34 | 9.9 KB |
| `UnderstandingDeltaCodec` (wire) | **0** | **0** | **1.9 KB** |

- **One flat op list, not six nested collections.** Intent is an explicit `op`
  field, never field presence. mem0, Graphiti and Letta converged on this
  independently; the measurable reason is that six `{add,revise,retire}` objects
  are six nested branch points and one array is one.
- **Sentinel encoding: every field required, `''` or `[]` means absent.** The
  reflex fix — required plus nullable — trades an optional for a union and lands
  in the *tighter* budget. Removing the branch entirely costs nothing. For enums
  the trick is `''` as a **member** of the enum, not a union with a literal:
  `z.enum(['','low'])` is one `enum` keyword, `z.enum(['low']).nullable()` is an
  `anyOf`. That single distinction is why the union count is zero rather than 4.
  It is only unambiguous because every field it touches is `.min(1)` in the
  domain, so `''` cannot be a real value.
- **One `z.codec`, not four hand-synced artifacts.** It yields the wire JSON
  Schema (`io: 'input'`), the domain type (`io: 'output'`), a total `decode`, and
  an `encode` used only by a property test — `decode(encode(x)) ≡ x` makes
  "someone added a domain field the wire has no home for" a CI failure.

**No adapter changed.** `@ai-sdk/provider-utils` already converts with
`toJSONSchema(schema, { target: 'draft-7', io: 'input' })` and validates with
`safeParseAsync` returning `result.data` — so a codec emits the wire schema and
returns a decoded domain value with no plumbing. Verified by reading
`dist/index.js` at v5.0.29. It also wraps every conversion in
`addAdditionalPropertiesToJsonSchema`, which closes a real Zod trap: the
`io: 'input'` projection **silently omits** `additionalProperties: false`, and
strict mode requires it. Anything bypassing the SDK must reimplement that.

**Decode failures are retryable, not fatal.** `ctx.issues.push(...)` inside the
codec produces an ordinary `ZodError`, which `withValidationRetry` already
re-asks on. Issues are reported at **wire paths** (`ops[3].kind`) rather than
domain paths, because a reask has to name something in the schema the model was
actually given.

**What this bought back.** `analyze` had been forced into Anthropic's `jsonTool`
mode to escape the cap, and forced tool use forbids extended thinking — so
`effort: 'high'` was unreachable on exactly the call that wanted it most. Every
operation is now inside both caps, so that fallback no longer fires. The
constraint was resolved by changing what the model is *asked for*, not by
weakening the domain.

**Two limitations, pinned by tests rather than discovered later.** `''` means
"leave unchanged" on a revise, so clearing a nullable field back to `null` is not
expressible (`retire` + `add` is the escape hatch); and `users: []` likewise
means unchanged, so clearing every user group is not expressible.

### The adapter chooses how to ask, per request (Phase 8)

**`StructuredGenerator` no longer assumes a provider can take a schema.** It used
to be `generate(schema, request)`, which quietly required a structured-output
feature — an abstraction that only abstracts over vendors that already agree.
Now it is `generate(elicitation)`, where the elicitation carries the schema and
its examples as one contract, and the adapter decides how to render it.

Three methods, ordered by the guarantee each gives up:

| Method | Guarantee | Cost |
| --- | --- | --- |
| `constrained` | malformed output is *unrepresentable* | hard caps on schema branchiness |
| `tool` | none — conformance moves to us | no size limit; some providers forbid thinking here |
| `prompted` | none | assumes only "can produce text" |

**Method choice is a pure function of a measurement and a table of caps.** No
library does this: Instructor, BAML and the AI SDK all take the mode as global
configuration, and a schema that turns out too branchy fails at request time.
That is a fine default when schemas are uniform and a bad one here, where
`analyze` and `assess` differ by an order of magnitude. `chooseMethod(budget,
caps, prefersThinking)` is testable with no key, and every choice carries the
`reason` that produced it.

**The one case where the ladder is not simply ordered by guarantee** is a
high-effort call on a provider whose tool mode forbids thinking. Anthropic's
`jsonTool` forces `tool_choice`, and forced tool use rejects extended thinking —
so dropping to `tool` on `analyze` would trade away the deliberation that made it
high-effort. `chooseMethod` prefers `prompted` there. `effort` reaches the
decision as a boolean, so no vendor vocabulary enters the pure function.

**Repair is a ladder, not a flag**, and every rung reports what it did:
extract the JSON from prose or a code fence → strip trailing commas → unwrap a
single-key envelope. Rungs are deliberately conservative. **Truncation is not
repaired**: appending the missing closers turns a cut-off list of requirements
into a shorter list that looks complete, and a shorter list is indistinguishable
from a correct one downstream. A retry is the honest outcome.

`Generated<T>` gained `method`, `raw` and `repairs`. `raw` is populated on the
prompted path and `null` on the other two — re-serializing a parsed object and
calling it "raw" would be a plausible lie in exactly the place a later reader
would trust it. Without `repairs`, "prompted mode works fine" is unfalsifiable.

**Examples are only sent on `prompted`.** It is the method with no structural
guarantee, so a worked example is doing the job a grammar would otherwise do;
paying tokens for one under a decoder is spending to restate a certainty.

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

### They render the deliberation, not just the decision (Phase 8)

**`ProjectionInput` was widened to `{ session, revision, sources, questions,
answers }`**, which closes a gap Phase 6 recorded verbatim: *"`whatWasAsked`
shows resolutions but not the question text, because Question records live in the
inquiry repository which projections don't receive."*

What that unlocks is the single most valuable thing an ADR provides. MADR's
most-cited section is *Considered Options with pros and cons*, because "why not
X?" is the question a specification can otherwise never answer — and the one
re-asked in every review until someone writes the answer down. It now renders:

```
**DEC-1** — core behaviour
  Users sign in via SSO
  because: Okta is already the org identity provider.
  settled by: answering "How should users sign in?"
  previously REQ-9
  chose: SSO via Okta — Every user needs an Okta account.
  considered and rejected: Magic links — No password to store, but every sign-in needs a working inbox.
  considered and rejected: Password plus TOTP — Full control, and a support burden for resets.
  we suggested Magic links; they chose otherwise
```

**Nothing is duplicated onto the `Decision` to get that.** `settledBy` names an
`Answer`, which names its `Question`, which holds every `Option` and what each one
`commits` you to. Copying the alternatives onto the Decision would denormalise
what a durable reference already reaches, and would then need keeping in sync
with the question it came from. This is the payoff for "references, not tags".

Three decisions inside it:

- **`questions` and `answers` are required, not defaulted to `[]`.** A default
  lets a caller forget and get a quietly thinner document; requiring them makes
  forgetting a compile error, which is the only version of that message anyone
  reads.
- **The join is shared in `projection/deliberation.ts`**, for the same reason the
  appendices are: three renderers each growing their own version of it is three
  places for the trail to diverge.
- **An unresolvable `settledBy` is dropped, not thrown.** Same asymmetry the
  engine uses — an unknown reference in a *delta* must fail the turn, but an
  unknown reference while *rendering* costs one absent paragraph where throwing
  costs the whole document.

**The agent prompt gets the rejected options too, and that is a departure worth
naming.** Its stated rule is to drop anything an agent cannot act on — which is
why it drops citations. A rejected option is the opposite: precisely actionable,
because it is the solution space closing. An agent proposing magic links after
the team rejected them costs a review cycle to rediscover something already
written down, which is the exact waste this product exists to prevent, aimed at
its own output. It renders compactly — the closed door, not the deliberation
around it.

**`InquiryRepository.listQuestions` was added** because the existing
`listUnansweredQuestions` excludes exactly the set a trail is made of: an
*answered* question. One drives the next prompt; the other explains the last
decision.

---

**Pure functions over a stored revision.** No model call. The `Understanding`
already holds every decision, open item and citation, and the caller supplies the
questions and answers behind them, so rendering is formatting. Free, instant, unit-testable, and unable to invent a
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
