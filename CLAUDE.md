# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Standing goal: build the owner's understanding, not just the code

The owner intends to hack this codebase directly, redirect its architecture, and learn the design process — not to receive a black box. So, alongside working code:

- **Explain the reasoning, not just the result.** When a non-obvious choice is made, say what was traded away and what the alternative would have cost. A decision the owner can't reconstruct is one they can't safely change.
- **Name the load-bearing parts.** Be explicit about which lines hold an invariant and which are incidental, so refactoring doesn't quietly break something.
- **Surface sharp edges as they're found** — library traps, silent-failure modes, false-positive-prone checks — and record them here or in a code comment. These are the things that cost hours later.
- **Be honest about weaknesses.** Flag the parts most likely to need rework and say why. Do not present a design as more settled than it is.
- **Prefer teaching the pattern over hiding it.** When something is deliberately explicit or repetitive, explain the invariant that repetition protects.

Do this after completing a single unit of work in-line in the Chat.

## Status

Phases 0–3 of `~/.claude/plans/polymorphic-gathering-crown.md` are done: tooling, boundary gates, the domain model, the engine loop, and Postgres storage with atomic turns. **No provider package is installed** — that is deliberate, and it is the evidence the ports hold. Real AI adapters, PDF/audio ingestion, projections, and the CLI do not exist yet. Add commands below as they land; never document a command that doesn't exist.

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
- **Timestamps are `text`, not `timestamptz`**, so the domain's ISO strings round-trip byte-identically. ISO-8601 UTC sorts correctly as text; SQL date arithmetic needs a `::timestamptz` cast.
- **Tests use PGlite** (Postgres in WASM, in-process). `docker-compose up -d` is for developing against a real server.
- `version` exists on `sessions` and is bumped on write but **not enforced**, and deliberately absent from the domain `Session`.

## Engine orientation

`runTurn` in `engine/loop.ts` is one iteration of the loop. Per turn:

1. `validateAnswer` on every answer — **before any model call**, so a malformed answer costs nothing
2. the configured strategy produces `{ understanding, delta, assessment, usage[] }`
3. `decideSufficiency` → verdict → session becomes `sufficient`, `exhausted`, or `awaiting-answers`
4. one `Turn` recorded with inputs, before/after revision ids, verdict, and per-operation usage

Load-bearing details:

- **`engine/context.ts` is the only place a model's input is assembled.** Token optimization (windowing, summarization, `Embedder` retrieval) lands there and nowhere else.
- **Two strategies, `REQUIRELY_TURN_STRATEGY`.** `separate` (3 calls) assesses the stored understanding; `merged` (2 calls) assesses a predicted one. The saving is exactly the compact projection's size per turn. An integration test asserts both reach the same outcome.
- **`merge` is passed _into_ strategies** rather than returning a delta to apply. Applying twice would draw two ID sequences from one `IdGenerator`; the callback makes that unexpressible, and a runtime guard catches it anyway.
- **Unknown IDs are handled asymmetrically on purpose.** `applyDelta` throws on a bad ID (one retry). `resolveBlockingGaps` and `selectQuestions` silently drop them, because a hallucinated blocking gap would veto sufficiency forever and deadlock the session.
- **Question ordering comes from `verdict.shortfalls`**, not a model-supplied priority — the same reasoning that removed `Requirement.confidence`.
- **The fake adapter validates scripted responses against the real schema.** A fixture that drifts fails exactly as a bad model response would.

Tests that wire adapters to the engine live in `src/integration/`, not `src/engine/` — the boundary rule forbids `engine/ → adapters/` with no test exemption.

## Domain model orientation

`src/domain/` has no I/O and depends on nothing but `zod`. Three pure functions carry the logic:

| Function            | Location                       | Contract                                                                                                                                    |
| ------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `applyDelta`        | `understanding/apply-delta.ts` | Merges a turn's changes into the next `Understanding`. All-or-nothing: unknown IDs throw `UnknownReferenceError` rather than being skipped. |
| `decideSufficiency` | `sufficiency/policy.ts`        | Turns the model's coverage assessment into a verdict via `SufficiencyPolicy`. The model supplies evidence; this supplies the decision.      |
| `validateAnswer`    | `inquiry/validate-answer.ts`   | Relational checks an `Answer` schema cannot express, since each needs the `Question`.                                                       |

Load-bearing conventions, each with a test pinning it:

- **Nullable, not optional.** Absent values are `null`, because the domain is stored as JSONB and `undefined` disappears on serialization. `round-trip.test.ts` asserts this for every entity.
- **Drafts vs entities.** A model emits `*Draft` (no `id`, no timestamps); the domain assigns identity via `IdGenerator`. Drafts are derived with `.omit({ id: true })` so they cannot drift from the entity.
- **`.prefault()`, not `.default()`, for nested objects.** Zod's `.default()` returns its argument _without parsing it_, so `.default({})` yields a bare `{}` and skips every inner default. `.prefault({})` parses first.
- **Revisions strip defaults.** `patchOf()` in `understanding/delta.ts` — `.partial()` alone leaves `.default()` intact, so a revision naming one field would silently overwrite the others with their defaults.
- **Unmentioned means unchanged; `null` means cleared.** `stripUndefined` in `apply-delta.ts` enforces this.

## Commands

```bash
pnpm verify        # typecheck + lint + boundaries + test — the gate CI runs
pnpm typecheck     # tsc --noEmit
pnpm lint          # biome check .        (pnpm lint:fix to apply)
pnpm boundaries    # architectural boundary check (see below)
pnpm test          # vitest run           (pnpm test:watch to watch)
pnpm vitest run src/config/env.test.ts    # a single test file

pnpm db:generate   # regenerate migrations from schema.ts — review the SQL diff
pnpm db:migrate    # apply migrations to DATABASE_URL
pnpm db:studio     # drizzle studio
docker compose up -d   # Postgres for local development (tests use PGlite instead)
```

## Toolchain sharp edges

- **pnpm 11 ignores the `pnpm` field in `package.json`** — settings live in `pnpm-workspace.yaml`, and putting them back in `package.json` only produces a warning. `esbuild` (drizzle-kit's dependency) needs **both** `onlyBuiltDependencies` and `allowBuilds` set there, or `pnpm install` exits non-zero.

## Toolchain constraints worth knowing before writing code

- **Node 24 runs `.ts` directly** via type stripping, so relative imports must carry the `.ts` extension (`import { x } from './x.ts'`).
- **Only erasable TypeScript compiles** (`erasableSyntaxOnly`): no `enum`, no constructor parameter properties, no `namespace`. Use `as const` objects with a derived union type instead of `enum`, and assign class fields in the constructor body.
- `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on. Optional fields that can genuinely be absent are declared `foo: T | undefined`, not `foo?: T`.

## Enforced architectural boundaries

Two gates enforce the provider-agnostic constraint, because a rule that lives only in prose decays silently:

- `pnpm boundaries` (`scripts/check-boundaries.sh`) — the CI gate. Covers all four rules, including "domain may only import `zod` and `node:` builtins", which is an allowlist Biome can't express.
- Biome `noRestrictedImports`, scoped per-directory in `biome.json` `overrides` — the editor gate, for feedback while typing.

The rules: `domain/` imports no outer layer and no third-party package but `zod` (test files may add `vitest`); `engine/` imports neither `adapters/` nor `app/`; **`ai` and `@ai-sdk/*` may only be imported under `src/adapters/ai/`**; and `Date.now()`, `new Date()`, `crypto.randomUUID()`, `Math.random()` appear nowhere in `domain/` or `engine/` — time and identity enter only through the `Clock` and `IdGenerator` ports.

After changing the script, re-prove it by planting deliberate violations and confirming each rule fires. An earlier version matched the word "from" inside comments and template literals; false positives are how a checker gets switched off.

Note on `biome.json`: later `overrides` entries _replace_ earlier ones for the same rule rather than merging, so each override repeats the AI-SDK patterns. Reordering or de-duplicating them will silently disable enforcement — verify with a deliberate violation after any change.

## Product

Requirely turns unstructured input (voice/audio, text, documents, code, conversations, existing requirements) into a complete understanding of what should be built, then projects that understanding into an SRS, a requirements document, or a prompt for an AI coding agent.

Read `requirely.md` before making design decisions — it is the source of truth for scope.

## The invariant that shapes the architecture

The product is the **requirement-gathering loop**, not the document:

`Input → Understand → Identify Gaps → Ask Questions → Receive Answers → Re-evaluate → (repeat if needed) → Finalize`

Consequences to hold when designing anything:

- **Understanding is the durable artifact.** Output formats are projections over it. State must never end up living inside the SRS/prompt generator.
- **Sufficiency is an explicit step.** Each iteration answers "do I have enough to confidently describe what needs to be built?" — that judgement should be an inspectable decision, not an emergent side effect of prompt wording.
- **Questions carry generated answer options** (the lowest-effort path), with some allowing a single option selection and others allowing multiple selections. All questions also accept a custom answer (the highest-flexibility path).
- **The output target is optional and late-binding.** A user may declare it upfront ("write an SRS") or pick it after dumping context. Ingestion and analysis must work without knowing the target.
- **Input modality is a mechanism, not an identity.** Voice is a priority input, but nothing below the ingestion boundary may be voice-shaped.
- Ask only the questions needed to reach sufficiency — question volume is a cost, not a feature.

Think of it as Claude Code Plan Mode but **on steroids**.

## Hard constraint: provider-agnostic AI

The application core is AI provider agnostic. The architecture does not constraint or mandate any provider. The architecture should allow use of different providers at different layers of the application simultaneously and naturally. E.g. transcription from one vendor, reasoning from another. Provider SDK types and vendor-specific concepts must not leak into domain or orchestration code.

## Initial scope

Backend only. No polished frontend. The bar for v1 is proving the gathering engine works end to end: ingest → transcribe when needed → analyze → identify gaps → generate questions with options → process answers → re-evaluate → decide completeness → generate the requested output.
