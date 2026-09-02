# Requirely — plan and state of play

Written for a future session that has none of this conversation. Read this first,
then the `CLAUDE.md` files (root, then `packages/core/`) for what is true *inside*
each package. `requirely.md` at the repo root is the product spec and the source
of truth for scope.

Companion documents: [DECISIONS.md](./DECISIONS.md) (what was chosen, what was
measured) and [WEAKNESSES.md](./WEAKNESSES.md) (what is known-wrong and what the
owner decided about it).

---

## 1. What the product is

Requirely turns unstructured input — voice, text, documents, code, conversations —
into a **structured understanding of what needs to be built**, then projects that
understanding into an SRS, a requirements document, or a prompt for an AI coding
agent.

> Think of it as Claude Code Plan Mode, but on steroids.

**The product is the requirement-gathering loop, not the document.**

```
Input → Understand → Identify Gaps → Ask Questions → Receive Answers
      → Re-evaluate → (repeat if needed) → Finalize
```

### The five invariants everything else follows from

1. **Understanding is the durable artifact.** Output formats are projections over
   it. State must never end up living inside a generator.
2. **Sufficiency is an explicit, inspectable step** — a recorded decision, not a
   side effect of prompt wording.
3. **Questions carry generated answer options** (single- or multi-select), and
   *always* accept a custom answer.
4. **The output target is optional and late-binding.** Ingestion and analysis
   must work without knowing it.
5. **Input modality is a mechanism, not an identity.** Nothing below the
   ingestion boundary may be voice-shaped.

Plus one hard constraint: **the core is AI-provider agnostic.** Different layers
may use different vendors at once. Provider SDK types must never reach domain or
orchestration code.

---

## 2. Where the code is

```
requirely/
├── apps/web/          Next.js — shell only, no core integration yet
├── packages/core/     the engine: domain, loop, adapters, ingestion, config
├── packages/ui/       design system
└── scripts/           cross-package boundary checks
```

`packages/core/src/` is the whole backend:

| Directory | Depends on | What lives there |
| --- | --- | --- |
| `domain/` | **only `zod`** | Entities, Zod schemas, all ports, three pure functions |
| `engine/` | domain only | `runTurn`, context assembly, prompts, strategies |
| `ingestion/` | domain | modality → normalized text; the only place a `Source` is created |
| `projection/` | domain only | SRS / requirements doc / agent prompt — pure, no model call |
| `adapters/` | domain | ai (fake, anthropic, openai, retry, recording), storage (memory, postgres), system (clock, ids) |
| `config/` | — | Zod-validated env |
| `observability/` | — | minimal `Logger` |
| `integration/` | everything | tests that wire adapters to the engine |

**`domain/` is isomorphic** — no `node:` imports, no third-party but `zod` — which
is what lets `apps/web` share the real `Question`/`Answer` schemas and the real
`validateAnswer` instead of a hand-maintained copy that drifts.

### The loop, concretely

`engine/loop.ts` → `runTurn(session, request, deps)`:

1. `validateAnswer` on every answer — **before any model call**, so a malformed
   answer costs nothing.
2. The configured strategy produces `{ understanding, delta, assessment, usage[] }`.
3. `decideSufficiency` → verdict → session becomes `sufficient`, `exhausted`, or
   `awaiting-answers`.
4. Returns a **`TurnCommit`** — a validated domain command. It writes nothing;
   `stores.committer.commit(commit)` persists it in one transaction.

---

## 3. Status

**Done:** phases 0–6, Phase 7 steps 0–1, **Phase 8 complete**.
**330 tests, 29 files.** `pnpm verify` covers typecheck (3 packages) + lint +
2 boundary scripts + node-runnable + tests.

**Phase 7 is parked mid-flight and Phase 8 is in progress.** The first live model
calls exposed a constraint nobody had designed for: providers compile strict
schemas into decoding grammars and cap their branchiness, and ours was 3× over.
Phase 8 is the redesign that follows. Phase 7 steps 2–4 (the `./server` export,
`apps/cli`, the self-gathering run) resume once it lands.

| Phase | State |
| --- | --- |
| 0 Scaffold | done |
| 1 Domain model + ports | done |
| 2 Fake adapter + engine loop | done |
| 3 Postgres storage, atomic turns | done |
| 3a `text` → `timestamptz(3)` | done (correction) |
| 3b Model-copyable identifiers | done (correction) |
| 4 Real AI adapters | code done; **one real run per provider still pending** |
| 5 Ingestion (text, PDF, DOCX, audio) | done — **code ingestion deliberately deferred** |
| 6 Projections (SRS, req doc, agent prompt) | done |
| 7 CLI — steps 0/1 | done: adapter fixes, cost accounting, the live harness, the first real call |
| 7 CLI — steps 2–4 | **parked** behind Phase 8 |
| 8 Harness redesign — step 1 (domain) | done — `Decision` tier, promotion, `Gap` deleted |
| 8 step 2 (wire + codec) | done — 0 optional / 0 union / 1.9 KB, inside every cap |
| 8 step 3 (adapters) | done — three methods behind one port, chosen per request |
| 8 step 4 (engine) | done — sufficiency counted, stalling, reasoned questions |
| 8 step 5 (projections) | done — the ADR trail, from a join rather than duplication |
| 8 step 6 (durable evals) | done — instrument tested; readings blocked on API spend |
| **7 steps 2–4** | **next** — `./server` export · `apps/cli` · the self-gathering run |

### What Phase 5 added

- `ingestion/service.ts` — the only place a `Source` is created. Owns the
  `SourceRepository`, so it assigns the session-scoped ordinal itself; that
  closes a gap open since Phase 3b.
- `adapters/extraction/{pdf,docx,composite}.ts` — `unpdf` and `mammoth` behind
  the `DocumentExtractor` port, routed by `supports()`.
- `adapters/transcription/{openai,fake}.ts` — `transcribe()` from `ai@7`.
- `SourceRepository.remove` — one legitimate caller: cleaning up a `pending` row
  whose transcription failed.
- `loadSources` in `engine/loop.ts` now **skips non-analyzable sources**, so a
  `pending` or `failed` source can never reach a model.

**Code ingestion is deferred** by owner decision. The `code` `SourceKind` stays
in the enum; nothing produces it.

### What Phase 6 added

- `projection/` — `project(target, { session, revision, sources })`, three
  renderers over one shared section library. **Pure functions**: no model call,
  no I/O, no tokens. Invariant #1 made executable.
- `finalizeSession` in `domain/session/` — the explicit act of finishing, kept
  separate because projections mutate nothing.
- Honesty is uniform: still-open items and unresolved contradictions render whenever
  they exist, not only when the budget ran out.
- The agent prompt renders still-open items as **"STOP — do not guess, ask"**, which is
  the product's own thesis applied to its own output.

### What Phase 4 added

- `adapters/ai/vercel.ts` — shared body of every AI-SDK-backed adapter.
- `adapters/ai/{anthropic,openai}.ts` — two real providers. Each maps the domain's
  `effort` differently (Anthropic: thinking budget; OpenAI: `reasoningEffort`),
  which is the evidence `effort` was a domain concept and not a vendor leak.
- `adapters/ai/retry.ts` — `withValidationRetry`, a decorator. Retries *only*
  schema failures (`CapabilityError.retryable`), feeding the Zod issues back.
- `adapters/ai/recording.ts` — cassettes keyed by a hash of the whole request, so
  CI replays real model output with no network and no spend.
- `observability/logger.ts` — minimal `Logger`, silent by default.

### What Phase 8 step 1 changed

The domain grew a settled tier and lost `Gap`. See DECISIONS.md for the reasoning;
the shape, briefly:

- **`Decision`** — `statement · kind · dimension · rationale · promotedFrom ·
  settledBy · supersededBy · provenance`. Immutable; replaced by supersession.
- **Promotion** — `decisions.promote` names an open item in `from`, creates the
  Decision and removes the item in one operation. Validated, not asserted:
  `applyDelta` throws when `from` names nothing, when the same item is promoted
  twice, when a cited source does not exist, or when nothing settled the decision
  at all.
- **`Gap`, `ResolvedGap`, `GapId` and `Contradiction.resolution` are gone.**
  `Question.gapId` became `dimension` + `about`, and the "must target an open gap"
  filter in `selectQuestions` was **deleted rather than ported** — that filter is
  what made a turn-one absence unaskable.
- **`OpenItemId`** is a brand supertype of the four item brands, expressible
  because Zod brands intersect. Widening is free; every narrowing is still an error.

**Honest note on the numbers.** Step 1 made the wire problem *worse*, measured:
`UnderstandingDelta` at `io: 'input'` went from 71 optional / 28 union to
**84 / 34**, against caps of 24 and 16. That was expected — the domain delta was
never meant to be sendable — and Step 2 fixed it below.

**Cassettes were deleted, not re-recorded.** The Phase 7 recordings were made
against the old schema; the org API spend limit blocks re-recording. `live.test.ts`
now skips loudly, which is the documented behaviour — see WEAKNESSES.md for why
the skip guard did not catch the orphaning itself.

### What Phase 8 step 2 changed

`src/wire/` now sits between the domain and every model. See DECISIONS.md for the
reasoning; the results:

| Operation | optional | union | size |
| --- | ---: | ---: | ---: |
| `analyze` (the codec) | 0 | 0 | 1.9 KB |
| `analyze-and-assess` | 1 | 0 | 2.5 KB |
| `assess` | 1 | 0 | 0.6 KB |
| `generate-questions` | 5 | 3 | 0.9 KB |

Every one is inside the 24 / 16 caps with room to spare, against 84 / 34 for the
domain delta a step ago.

- **No adapter changed.** `@ai-sdk/provider-utils` converts with `io: 'input'` and
  validates with `safeParseAsync` returning `result.data`, so a `z.codec` emits
  the wire schema and hands back a domain value with no plumbing.
- **`effort: 'high'` is reachable on `analyze` again.** It had been forced into
  `jsonTool` mode to escape the cap, and forced tool use forbids thinking. That
  fallback stays as graceful degradation but should now be unreachable — a test
  asserts the caps at CI time.
- **The fake generator validates fixtures against the codec**, so `scenario.ts` is
  written in the wire format and every integration run exercises `decode`.
- **Boundary rule 6**, both directions: `wire/` may reach only `domain/`, and
  `domain/` may not reach `wire/`. Re-proved with four planted violations plus a
  negative control.

### What Phase 8 step 3 changed

The port stopped assuming a provider can take a schema. See DECISIONS.md for the
reasoning; the shape:

- **`generate(elicitation)`** replaces `generate(schema, request)`. The schema and
  its examples travel as one contract, because they are one.
- **Three methods**, chosen per request by `chooseMethod(budget, caps,
  prefersThinking)` — a pure function over a measurement, testable with no key.
  `prompted` is the floor: it assumes only that a model can produce text.
- **`wire/budget.ts`** is the single schema measurer, shared by the CI budget
  test, the runtime method choice and the live probes. It was three copies.
- **A repair ladder** — extract → strip trailing commas → unwrap an envelope —
  each rung pure, conservative and self-reporting. Truncation is deliberately not
  repaired.
- **`Generated<T>` gained `method`, `raw`, `repairs`**, and cassettes store the
  first and last so a replayed eval reports what really happened.

Two bugs the new tests caught, both silent:

- `extractJson` returned the first *balanced* span, which is `{curly}` in the
  sentence "use {curly} braces". Balance is not JSON; candidates must parse, and
  the longest one wins.
- `translate()` re-wrapped a `CapabilityError` thrown by our own prompted path,
  downgrading `retryable: true` to false — so a recoverable prompted failure was
  never retried.

### What Phase 8 step 4 changed

The verdict stopped being a model grading its own homework. See DECISIONS.md for
the reasoning; the shape:

- **Three counted conditions** decide sufficiency: no blocking open items, every
  required dimension has a Decision behind it, and more Decisions than uncertain
  items. The middle one is what stops a settled *ratio* being gamed by promoting
  a single requirement.
- **Coverage is advisory.** It orders questions and appears in the rationale; it
  cannot make or block a verdict. Two tests pin both directions.
- **`stalled` is a session status**, reached after two turns settling nothing new
  and distinct from `exhausted`. Movement counts `decisions + superseded`, so a
  supersession reads as progress rather than as a wasted turn.
- **Questions carry reasoning**: `rationale` required, `commits` required per
  option, `recommends`/`because` as withholdable fields, `settles` read by the
  engine when building the settlement map.

Two traps found on the way, both recorded in WEAKNESSES.md:

- `.omit()` throws at **runtime** on a Zod object carrying refinements, and `tsc`
  is green. Adding cross-field rules to `Question` broke `QuestionDraft` with a
  fully passing typecheck; the fix is a `QuestionShape` base that drafts derive
  from.
- The shared scenario's `answerAll` minted `ans-1` on every turn, so any test
  running three turns died on a primary-key conflict — exactly the collision
  Phase 7 predicted for a persisted session.

**One fixture had to get more honest.** Under the old verdict the shared scenario
reached `sufficient` on two promotions because a scripted assessment said
coverage was 0.9. It now settles all five required dimensions, two from answers
and three from the source.

### What Phase 8 step 5 changed

The mechanical half was already done in step 1 — the projections were rebuilt
onto `currentDecisions()` then. This step did the part the plan called
non-mechanical.

- **`ProjectionInput` carries `{ questions, answers }`**, required rather than
  defaulted, closing the Phase 6 gap by construction.
- **`projection/deliberation.ts`** joins Decision → Answer → Question → Options
  once, shared by the requirements document and the agent prompt.
- **Appendix D became the ADR trail**: what was chosen, what was considered and
  rejected with what each would have cost, and whether Requirely's own
  recommendation was overridden.
- **A source-settled decision names its source's label**, not `src-1`.
- **The agent prompt gets the rejected options** — a departure from "drop anything
  an agent cannot act on", justified because a rejected option *is* actionable.
- **`InquiryRepository.listQuestions`** added, since `listUnansweredQuestions`
  excludes precisely the answered questions a trail is made of.

### What Phase 8 step 6 changed

- **`observability/session-metrics.ts`** — a pure function over what a session
  already stores, producing seven derived numbers including the two instruments
  the design is explicitly worried about.
- **`adapters/ai/metering.ts`** — a third `StructuredGenerator` decorator, because
  `Generated.method` and `Generated.repairs` are per-call facts a `Turn` does not
  carry.
- **`integration/strategy.eval.test.ts`** — two halves. The instrument half runs
  always on the fake and claims only that the harness works; the readings half
  needs a model and skips loudly.
- **`integration/live-harness.ts`** — the cassette and skip machinery, shared so
  two model-backed files cannot grow two ideas of what "no cassettes" means.

**What the instrument reports today**, on the fixture session:

```
separate: sufficient after 2 turn(s), 5 calls · 3764 in / 1339 out
merged  : sufficient after 2 turn(s), 3 calls · 3579 in / 1350 out
```

Same outcome, two fewer calls — the only thing a scripted run can honestly
settle, because it is a property of the engine rather than of a model.

### The immediate next step

**Phase 7 steps 2–4, resumed.** The `./server` re-export manifest with boundary
rules 6/12/13, then `apps/cli` with its own composition root, then the
self-gathering run.

`apps/cli generate` is also the first real caller of `project()` — every current
caller builds `ProjectionInput` by hand in a test, so the deliberation join is
proven against fixtures only.

Blocked on API spend, and the largest gap in the project: **nothing has been
measured against a real model since the domain was reshaped.** No cassettes, no
generation-method comparison, no anchoring reading. Everything Phase 8 built is
correct by construction and unvalidated by observation.

---

## 4. Decisions already banked for later phases

- **Phase 6 projections render deterministically** — pure functions over
  `UnderstandingRevision`, no model call. `req-1` renders as `REQ-1`: the stored
  id *is* the citation number. An `exhausted` session renders a "still open and
  assumptions" section so an under-informed document says so.
- **Phase 7's CLI stays small and interactive.** It is a *playground*, not the
  product — a way to exercise the engine, not a surface to invest in.
- **Phase 7 will force the `./server` question.** `@requirely/core` exports only
  `./domain`, and frontend rule 8 forbids apps anything else. That rule conflates
  *"runs in a browser"* with *"is an app"*. The resolution is a `"./server"`
  export plus narrowing rule 8 to `apps/web` **by name** — not widening it until
  it stops complaining. Rule 7 (no server-only dependency in the browser graph)
  stays as the backstop.

---

## 5. How to work in this repo

```bash
pnpm verify        # the whole gate — run this before saying anything is done
pnpm test          # vitest in packages/core
pnpm db:generate   # regenerate migrations from schema.ts; review the SQL diff
docker compose up -d   # Postgres for local dev (tests use PGlite instead)
```

Working agreement, from the root `CLAUDE.md`: the owner intends to **hack this
codebase directly and learn the design process**. So explain reasoning and
trade-offs, name the load-bearing parts, surface sharp edges, be honest about
weaknesses, and **summarize after each unit of work in the chat**.

Two habits this project runs on, both of which have repeatedly paid:

- **Measure instead of asserting.** Several confident claims here were wrong and
  were caught by a five-minute experiment. See DECISIONS.md.
- **Make constraints executable.** Rules that live only in prose decay. Every
  architectural constraint here fails CI.
