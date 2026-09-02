# Known weaknesses

Everything here is known-wrong or known-missing. Nothing in this list is a
surprise, and none of it should be discovered again from scratch.

Owner verdicts are recorded verbatim in intent — **do not silently re-decide
them.** If evidence changes, say so and ask.

---

## Carrying owner verdicts

| # | Weakness | Verdict |
| --- | --- | --- |
| 1 | **`Provenance.quote` is never verified against the source text.** A model can fabricate a citation and it renders in an SRS looking authoritative. | **Expected.** Fix properly in a later iteration. |
| 2 | ~~`Requirement.confidence` was decorative~~ | **Done** — removed in Phase 2. |
| 3 | **`Understanding` grows unbounded** — every collection, not just requirements. Eventually the analyze prompt will not fit. | **Keep building the dev version.** Optimize when *either* context limits start exhausting fast *or* token spend gets expensive, even in development. **Token usage is a standing priority.** |
| 4 | **An item added and promoted in the same delta is unsupported** — the model cannot reference an id that does not exist yet. (Was "a gap added and resolved"; `Gap` is gone but the shape of the limitation is identical.) | Support it **properly, when appropriate**. Mechanism when needed: a client-supplied `tempId` on `add` that `promote` may reference, translated inside `applyDelta`. |
| 5 | **No optimistic concurrency.** `sessions.version` exists and is bumped, but nothing reads it. | Not a priority. The column is present so enforcement is later a `WHERE` clause, not a migration. |
| 6 | ~~`resolvedGaps` never shrinks~~ → **`decisions[]` never shrinks.** Same shape, deliberately reintroduced in Phase 8: a superseded Decision is marked, never removed, because the ADR rule is that the trail of supersessions *is* the history. | Same trigger conditions as #3 — but note this one is now a **design commitment**, not an oversight. Pruning it would be pruning the audit trail. |

**Weakness #3 is the one to watch.** The mitigation is already placed:
`engine/context.ts` is the *single* place any model input is assembled, so
windowing, summarization, or retrieval through the (defined, unimplemented)
`Embedder` port all land in one file.

---

## Open, no verdict yet

**Constraint violations surface as raw driver errors.** Postgres throws a
`postgres.js` error with code `23505`; the in-memory adapter throws a plain
`Error`. Neither is a domain error type, so a caller cannot tell "duplicate" from
"connection died" without inspecting vendor fields — a small version of the leak
the architecture otherwise forbids. Wants a `ConflictError` mapped in the adapter.

**OpenAI's grammar caps are guessed, not measured.** `OPENAI_CAPS` in
`adapters/ai/openai.ts` is set to 20 / 12 — deliberately below Anthropic's 24 / 16,
because OpenAI's structured outputs are documented as accepting less
([JSONSchemaBench] measured them compiling 6–13% of hard schemas against ~60% for
the best open engine). The direction of the error is safe: too-low caps degrade
to `tool` early rather than 400ing late. But they are unverified — the probe that
would settle them is blocked on the org API spend limit.

**`minimumSettledRatio` and `stallAfterTurnsWithoutProgress` are unmeasured.**
0.5 is the owner's stated goal written as a number and 2 turns is "one quiet turn
is noise, two is a pattern" — neither has been checked against a real session. If
the loop turns out to stall early on genuinely hard input, or to declare
sufficiency on thin documents, these are the two numbers to move. They are policy
fields precisely so moving them is not a code change.

**Coverage now costs a model call per turn and decides nothing.** `assess` still
orders questions and supplies the rationale a human reads, and it catches shallow
decisions that counting cannot — but that is a weaker justification for a whole
call than "it decides when we stop" was. The `merged` strategy already folds it
into one call; if the evals show the ordering barely changes outcomes, dropping
`assess` entirely is a real option.

**`prompted` generation has never run against a real model.** It is covered by
unit tests and a mock model, which prove the wiring and the repair ladder. What
they cannot prove is the thing that matters: whether a real model, handed a JSON
Schema in prose, produces something the ladder can recover. Step 6's evals are
where that gets a number.

**A replay never exercises the provider adapter.** Cassettes record at the *port*,
so `recording.ts` replays a stored value and never calls `generateObject`. Request
building, usage mapping and error translation are covered separately by
`vercel.test.ts` against a mock model — but the two halves are never exercised
together without a live call. HTTP-level recording would close this; it is more
machinery than it is currently worth.

**~~`ingestText` requires an `ordinal` from the caller~~ — closed in Phase 5.**
`ingestion/service.ts` owns the `SourceRepository` and assigns ordinals itself.

**The id change is unmeasured against a real model.** Every known risk factor is
reduced — 40 characters to ~5, no shared prefixes, a small candidate set — but the
actual improvement in copy accuracy is unverified. Phase 4's first real runs are
the moment to check it, and the recording adapter makes it directly observable.

**Enum-constrained decoding is available and not done.** Now that valid ids are a
few dozen short strings, putting them into the response schema as a `z.enum` would
make an invalid reference *unemittable* where the provider supports constrained
generation. The natural follow-on if measurement shows ids are still being missed.

**Prompts are written for contract-correctness, not tuned for quality.**
`engine/prompts.ts` explains the delta rules precisely. Nothing has measured
whether it produces *good* requirements. That needs real models plus cassettes.

**No eval harness.** `Turn` records the `SufficiencyVerdict` and `usage`, which is
exactly the data a scored eval suite would need — but nothing scores it, so "did
my prompt change help?" is currently unanswerable.

**A crash mid-transcription leaves a stuck `pending` row.** The failure path
deletes it, but a process that dies between `add` and the `catch` cannot. Nothing
reaps orphans. Harmless today — `loadSources` skips non-analyzable sources, so a
stuck row is invisible to the engine — but it needs a sweep once transcription
moves to a job queue.

**Large audio is not chunked.** Above the provider's file-size limit,
transcription fails with the vendor's message. Chunking a meeting recording and
stitching the transcript is real work and nothing needs it yet; truncating
silently would be worse than failing.

**Code ingestion does not exist.** Deferred by owner decision; the `code`
`SourceKind` stays in the enum with nothing producing it. When it arrives the
open question is scope — a repository's full text is precisely the unbounded
growth weakness #3 warns about, so it needs an explicit byte budget enforced at
the ingestion boundary, where it can be explained.

**Media type comes from the file extension.** A `.pdf` that is really a ZIP
reaches `unpdf` and fails there rather than being caught up front. Deliberate: a
wrong extension is a user error worth surfacing. Magic-byte sniffing is the
upgrade if it becomes a nuisance.

**No auth, no multi-tenancy.** Session rows carry no `ownerId`. Additive later.
`Decision.settledBy` being a durable id rather than a tag is what makes "which
user settled this?" answerable when it arrives — that is the whole reason
`settledBy: 'user'` was rejected during the Phase 8 design.

~~**The domain delta is not sendable.**~~ **Closed in Phase 8 Step 2.** The
domain delta is still 84 optional / 34 union / 9.9 KB and still not sendable —
deliberately — but nothing sends it any more. `src/wire/` measures 0 / 0 / 1.9 KB
and every operation is inside the caps. See DECISIONS.md.

**The wire's loose `WireItem` moves validation risk into the codec.** `WireOp` is
a superset — an assumption's `basis` and a constraint's `category` sit side by
side — so `decode` is what narrows it per target. If `decode` is wrong, wrongly
shaped data reaches the domain. Two mitigations, both real: the domain schema is
still the final gate and re-parses everything, and `decode` is pure with 24 tests
on it. Watch this if the wire grows a target.

**`decode` reports at wire paths, but the domain's own errors do not.** A failure
`decode` catches says `ops[3].kind`, which a model can act on. A failure that gets
past it into `UnderstandingDelta.parse` says `requirements.add.0.kind` — a path in
a schema the model never saw. The reask is still useful (the message names the
field) but it is not as good, so per-kind checks belong in `decode` rather than
being left to the domain.

**The live-cassette guard answers "was anything recorded?", not "is it still
valid?"** A cassette key hashes `(operation, instructions, input)`, so changing a
prompt or a schema *orphans* a cassette rather than invalidating it: the skip
guard still sees a file naming the right model, returns `true`, and the failure
surfaces three calls deep as `no cassette at …`. Hit for real when Phase 8
reshaped the domain. The fix is to delete the orphans — a cassette recorded
against a schema that no longer exists is evidence for a claim nobody is making —
not to widen the guard.

---

## Sharp edges (things that cost hours)

Recorded in the `CLAUDE.md` files too; repeated here because they are the kind of
thing that gets rediscovered painfully.

- **`pnpm test` passing is not evidence Node can run the code.** Vitest transpiles
  with its own pipeline. `pnpm node-runnable` is the gate that observes it.
- **pnpm 11 ignores the `pnpm` field in `package.json`** — settings live in
  `pnpm-workspace.yaml`, silently. `esbuild` needs *both* `onlyBuiltDependencies`
  and `allowBuilds` there, or `pnpm install` exits non-zero.
- **Biome `overrides` entries *replace* each other per rule rather than merging.**
  An early boundary config silently caught only 2 of 4 planted violations. After
  changing any boundary rule, re-prove it by planting deliberate violations.
- **Boundary checkers must not match prose.** An early version flagged the word
  "from" inside comments and template literals. False positives are how a checker
  gets switched off.
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
  all. After renaming a field, grep for the old name in fixtures — the compiler
  will not.
- **`unpdf` rejects a Node `Buffer`** — *"Please provide binary data as
  `Uint8Array`, rather than `Buffer`"* — even though `Buffer` extends
  `Uint8Array` and satisfies the port's type. Any caller using `fs.readFile`
  hits it. `pdf.ts` normalizes with a zero-copy view.
- **AI SDK v7 provider-level usage is nested** (`inputTokens: { total, noCache,
  … }`) while the flattened `LanguageModelUsage` on the result is not. A mock
  returning the flat shape yields zeros.
