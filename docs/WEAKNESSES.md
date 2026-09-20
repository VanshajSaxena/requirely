# Known weaknesses

Everything here is known-wrong or known-missing. Nothing in this list is a
surprise, and none of it should be discovered again from scratch.

Owner verdicts are recorded verbatim in intent — **do not silently re-decide
them.** If evidence changes, say so and ask.

**What is *not* here, deliberately.** Library and toolchain traps live in
[TRAPS.md](TRAPS.md) — they have no fix, so they could never be triaged off a
backlog. Limitations chosen on purpose live under *Deliberate limitations* in
[DECISIONS.md](DECISIONS.md) — a decision filed as a weakness makes the backlog
look longer than it is and invites someone to "fix" what is working as intended.
Both were split out of this file; nothing was lost.

---

## The gap that matters most

### The loop does not close on real input — the biggest gap in the product

**Measured on `requirely.md` against `claude-haiku-4-5`, twice, reproducibly.**
Turn 1 is strong: the model reads an 11 KB spec, settles 5–8 decisions directly
from it with real rationales, leaves 6–18 items open, invents at most one
assumption, and asks four well-targeted questions with real consequences on every
option. **Turn 2, given four substantive human answers, returns an entirely empty
delta** — no promotion, no new decision, no revision.

The loop's central promise is `Receive Answers → Re-evaluate`. That step does
nothing today. Everything downstream of it — sufficiency, stalling, the
deliberation trail, the generated document — is therefore reachable only in
tests, because a real session never advances past turn 1.

The plumbing is *not* the problem: the fake-backed integration test folds answers
in and promotes correctly, so `renderAnswers` → `buildAnalyzeInput` → `analyze`
works. What is missing is that **nothing tells the model an answer is a settling
event.** `ANALYZE_INSTRUCTIONS` mentions answers once, in passing, and the
`TIERS` block explains *how* to promote without ever saying *when*. By turn 2 the
answers sit far down a long input, behind a much larger "current understanding"
block.

Three things to try, cheapest first:

1. **Say it in the prompt.** An explicit instruction that every answered question
   should produce a promotion or an explicit note of why it could not.
2. **Move the answers to the top of the input**, or repeat them at the end.
   `engine/context.ts` is the single token seam, so this is a one-file change.
3. **Check whether it is a model-capability limit** by running the same session on
   `claude-opus-5`. This is exactly what the eval harness exists to answer.

Until one of them lands, treat "Requirely can gather requirements end to end" as
**unproven**.

#### Update — measured on a *small* input, and the diagnosis above is incomplete

**Run: a 353-byte brief, `claude-haiku-4-5`, real Postgres, through the CLI.**
Turn 1 was again strong — three decisions that matched exactly what the brief
actually decided, two open items for exactly what it did not, one of them
correctly flagged blocking. Turn 2, given answers, **did not return an empty
delta.** It tried to settle, and the domain rejected the whole turn:

```
Delta references 1 unknown decision (settledBySourceId) id(s):
  qst-01a07d2c-24fb-77ff-87be-bd6a26e2f6d3
```

That is the **wire gap firing for real**, not the prompt gap. The model had an
answer, wanted to record what settled a decision, and the only field available is
`settledBySourceId` — so it put the *question id* there, which is the closest
thing to an answer handle the prompt ever shows it. `renderAnswers` prints
`Q [qst-<uuid>]`, so we display an identifier and then reject every use of it.

Three corrections this forces to the entry above:

- **"Turn 2 does nothing" was an over-generalisation from one input size.** On a
  short brief the model does attempt to fold answers in. The empty deltas on the
  11 KB spec may be a context-length effect rather than the same failure.
- **The failure is fatal, not silent.** `UnknownReferenceError` is thrown from
  `applyDelta` inside `merge`, which `strategies.ts` calls *between* the analyze
  and assess calls — outside the generator — so `withValidationRetry` structurally
  cannot see it. The turn is paid for and lost.
- **Ordering: the wire gap now looks like the first thing to fix**, not the
  prompt. Prompt changes cannot help a model that has no legal field to write.

**Confirmed working in the same run, and worth stating:** the failed turn wrote
**nothing** — 1 turn, 1 revision, 0 answers, unchanged. Phase 3's `TurnCommit`
design (read and compute, then persist in one transaction) is now proven against
real Postgres by a real failure rather than by a test that simulated one.

---

## Carrying verdicts

Numbers 1, 3, 4 and 5 are the owner's original verdicts and are cited from code
(`adapters/ai/pricing.ts` names verdict #3) — **do not renumber them.** Number 6
moved to *Deliberate limitations* in DECISIONS.md: `decisions[]` never shrinking
is an ADR commitment, not an oversight.

| # | Weakness | Verdict |
| --- | --- | --- |
| 1 | **`Provenance.quote` is never verified against the source text.** A model can fabricate a citation and it renders in an SRS looking authoritative. | **Expected.** Fix properly in a later iteration. |
| 3 | **`Understanding` grows unbounded** — every collection, not just requirements. Eventually the analyze prompt will not fit. | **Keep building the dev version.** Optimize when *either* context limits start exhausting fast *or* token spend gets expensive, even in development. **Token usage is a standing priority.** |
| 4 | **An item added and promoted in the same delta is unsupported** — the model cannot reference an id that does not exist yet. | Support it **properly, when appropriate**. Mechanism when needed: a client-supplied `tempId` on `add` that `promote` may reference, translated inside `applyDelta`. |
| 5 | **No optimistic concurrency.** `sessions.version` exists and is bumped on write, but nothing reads it. | Not a priority. The column is present so enforcement is later a `WHERE` clause, not a migration. |
| 7 | **No cassettes exist, so every model-backed suite skips.** A `claude-haiku-4-5` session did run end to end — 6 calls, 0 schema retries, all `constrained`, $0.2414 — but the recordings were deleted when the prompts were re-keyed. Carries three sub-gaps: **`prompted` has never produced a real reply**, **`stalled` and `sufficient` have never been reached live**, and **provider caps are now measured, not guessed.** OpenAI permits **zero** optional
properties (strict mode requires `required` to name every key — categorical, not a
branchiness budget); the table said 20, which is why the step-down never fired and
`assess` 400'd. Anthropic and Google both accept an optional property in constrained
mode, verified by real calls. Every operation now runs on all three, with
`generate-questions` degrading to `tool` on OpenAI only, and `adapters/ai/caps.test.ts`
gates the whole matrix at CI. Still unverified: DeepSeek (no key), the OpenAI/Gemini
*union* limits (our schemas never approach them), and `prompted`, which has still never
produced a real reply. | **Defer — record once the prompts settle.** The cassette key hashes `(operation, instructions, input)`, and Phase 10 made `instructions` a function of five dials, so any re-tune orphans the lot. Recording now buys evidence the next edit throws away. ~$0.30–0.50 per suite when the time comes. |
| 8 | **`minimumSettledRatio` (0.5) and `stallAfterTurnsWithoutProgress` (2) are unmeasured.** One is the owner's goal written as a number, the other is "one quiet turn is noise, two is a pattern". Phase 10 made both derivable from the `thoroughness` dial, which changed their shape without measuring the base. | **Defer with #7** — measuring needs a real session, and they are policy fields precisely so moving them is not a code change. |
| 9 | **Coverage costs a model call per turn and decides nothing.** Since Phase 8 the verdict is counted, not scored, so `assess` can neither create nor block it. It still orders questions and catches shallow decisions counting cannot see. | **Defer.** Revisit when the evals can measure whether question ordering changes outcomes; if it barely does, dropping `assess` is worth a third of every turn's calls. |
| 10 | **Extended thinking on `analyze` costs 2.5×.** Same fixture and model: $0.0954 / 16,411 output tokens without, $0.2414 / 46,164 with. The Phase 8 write-up called recovering it an unambiguous win; it is a *trade*. | **Defer.** Owner's standing instruction: effort levels stay untouched, cost experiments come later. The knob is `EFFORT.analyze` in `engine/steps.ts`. |
| 11 | **A replay never exercises the provider adapter.** Cassettes record at the *port*, so `recording.ts` replays a stored value and never calls `generateObject`. Request building, usage mapping and error translation are covered separately against a mock model — the two halves are never exercised together without a live call. | **Defer.** HTTP-level recording would close it and is more machinery than it is currently worth. |
| 12 | **Enum-constrained ids are available and not done.** Valid ids are now a few dozen short strings, so `wire/delta.ts`'s `id: z.string()` could be a `z.enum`, making an invalid reference *unemittable* where the provider supports constrained decoding. | **Defer.** No reference failure has been seen in nine live calls, and it would make the schema per-turn — defeating `budgetOf`'s cache and buying nothing on DeepSeek. |
| 13 | **A crash mid-transcription leaves a stuck `pending` row.** The failure path deletes it; a process that dies between the insert and the `catch` cannot. Nothing reaps orphans. | **Defer.** Harmless today — `isAnalyzable()` is false for a text-less source and `loadSources` skips those — and the fix belongs with the job queue that does not exist yet. |
| 14 | **Large audio is not chunked.** Above the provider's file-size limit, transcription fails with the vendor's message. | **Defer.** Nothing needs it, and failing loudly beats truncating silently. |
| 15 | **Code ingestion does not exist.** The `code` `SourceKind` stays in the enum with nothing producing it. | **Deferred by owner.** When it arrives, scope is the open question: a repository's full text is exactly the unbounded growth #3 warns about, so it needs a byte budget enforced at the ingestion boundary. |
| 16 | **The wire's loose `WireItem` moves validation risk into the codec.** `WireOp` is a superset — an assumption's `basis` and a constraint's `category` side by side — so `decode` narrows it per target. If `decode` is wrong, wrongly shaped data reaches the domain. | **Defer**, and B2 shrinks it. Two mitigations are real: the domain schema re-parses everything, and `decode` is pure with 24 tests. Revisit if the wire grows a target. |
| 18 | **`applyDelta`'s failures are fatal rather than re-askable.** A decision citing nothing and a promote naming a missing item both *pass* the codec cleanly, then throw `UnsettledDecisionError` / `UnknownReferenceError` from `applyDelta` inside `merge()` — which `strategies.ts` calls between the analyze and assess calls, outside the generator, so `withValidationRetry` structurally cannot see them. A paid turn is lost. Observed live: the turn that cited a `qst-` id in `settledBySourceId`. | **Low priority, deferred.** The fix needs the codec to take per-turn context (`knownSourceIds`, open item ids) and stop being a module constant. Same root as the loop gap above. |
| 17 | **The `analyze` and `assess` prompts are unmeasured for quality.** Phase 10 measured one dial on the *questions* prompt — creativity 0.1 produced extraction, 0.9 produced hypotheses (see DECISIONS.md) — but nothing has measured whether `analyze` produces good requirements or `assess` scores usefully. | **Defer with #7.** Both need cassettes plus a second model to compare against. |

---

## Traps

Moved to **[TRAPS.md](TRAPS.md)** — sixteen library and toolchain traps that cost
hours each, plus the finding that a prompt naming a failure mode suppresses the
behaviour near it. None is open work and none has a fix.
