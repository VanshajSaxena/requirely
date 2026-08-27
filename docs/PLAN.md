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

**Done:** phases 0–6. Only the CLI remains.
**184 tests, 18 files.** `pnpm verify` covers typecheck (3 packages) + lint +
2 boundary scripts + node-runnable + tests.

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
| **7 CLI** | **next — the last phase** |

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
- Honesty is uniform: open gaps and unresolved contradictions render whenever
  they exist, not only when the budget ran out.
- The agent prompt renders open gaps as **"STOP — do not guess, ask"**, which is
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

### The immediate next step

**Run each provider once for real.** Nothing has yet touched a live model. Needs
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. Record and report:

- what a turn actually costs,
- whether the `effort` mapping behaves sensibly,
- **how often output fails schema validation** — the retry decorator logs every
  attempt, and a turn whose `usage` array holds more entries than it made
  operations is visibly a turn that retried.

Then **Phase 7, the CLI** — the last phase. It stays small and interactive: a
playground for exercising the engine, not a surface to invest in. It will force
the `./server` export question below.

---

## 4. Decisions already banked for later phases

- **Phase 6 projections render deterministically** — pure functions over
  `UnderstandingRevision`, no model call. `req-1` renders as `REQ-1`: the stored
  id *is* the citation number. An `exhausted` session renders a "Known gaps and
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
