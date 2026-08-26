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
| 4 | **A gap added and resolved in the same delta is unsupported** — the model cannot reference an id that does not exist yet. | Support it **properly, when appropriate**. Mechanism when needed: a client-supplied `tempId` on `gaps.add` that `gaps.resolve` may reference, translated inside `applyDelta`. |
| 5 | **No optimistic concurrency.** `sessions.version` exists and is bumped, but nothing reads it. | Not a priority. The column is present so enforcement is later a `WHERE` clause, not a migration. |
| 6 | **`resolvedGaps` never shrinks** — a growing tail in a JSONB blob re-parsed every turn. | Same trigger conditions as #3. |

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
- **`Set.add()` returns the Set, not a boolean.** `!seen.add(id)` is always false;
  a duplicate check written that way never fires.
- **`unpdf` rejects a Node `Buffer`** — *"Please provide binary data as
  `Uint8Array`, rather than `Buffer`"* — even though `Buffer` extends
  `Uint8Array` and satisfies the port's type. Any caller using `fs.readFile`
  hits it. `pdf.ts` normalizes with a zero-copy view.
- **AI SDK v7 provider-level usage is nested** (`inputTokens: { total, noCache,
  … }`) while the flattened `LanguageModelUsage` on the result is not. A mock
  returning the flat shape yields zeros.
