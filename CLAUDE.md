# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

Phases 0–1 of `~/.claude/plans/polymorphic-gathering-crown.md` are done: tooling, boundary gates, and the full domain model (entities, Zod schemas, all ports, three pure functions). The engine, adapters, storage, projections, and CLI do not exist yet. Add commands to the section below as they land; never document a command that doesn't exist.

## Domain model orientation

`src/domain/` has no I/O and depends on nothing but `zod`. Three pure functions carry the logic:

| Function | Location | Contract |
|---|---|---|
| `applyDelta` | `understanding/apply-delta.ts` | Merges a turn's changes into the next `Understanding`. All-or-nothing: unknown IDs throw `UnknownReferenceError` rather than being skipped. |
| `decideSufficiency` | `sufficiency/policy.ts` | Turns the model's coverage assessment into a verdict via `SufficiencyPolicy`. The model supplies evidence; this supplies the decision. |
| `validateAnswer` | `inquiry/validate-answer.ts` | Relational checks an `Answer` schema cannot express, since each needs the `Question`. |

Load-bearing conventions, each with a test pinning it:

- **Nullable, not optional.** Absent values are `null`, because the domain is stored as JSONB and `undefined` disappears on serialization. `round-trip.test.ts` asserts this for every entity.
- **Drafts vs entities.** A model emits `*Draft` (no `id`, no timestamps); the domain assigns identity via `IdGenerator`. Drafts are derived with `.omit({ id: true })` so they cannot drift from the entity.
- **`.prefault()`, not `.default()`, for nested objects.** Zod's `.default()` returns its argument *without parsing it*, so `.default({})` yields a bare `{}` and skips every inner default. `.prefault({})` parses first.
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
docker compose up -d   # Postgres, once storage lands in Phase 3
```

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

Note on `biome.json`: later `overrides` entries *replace* earlier ones for the same rule rather than merging, so each override repeats the AI-SDK patterns. Reordering or de-duplicating them will silently disable enforcement — verify with a deliberate violation after any change.

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
