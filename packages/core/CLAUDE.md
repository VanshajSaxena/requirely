# CLAUDE.md — @requirely/core

Requirely's brain: the domain model, the gathering engine, and the adapters behind
its ports. A **library**, not a deployable — it has no entry point. Front doors
(`apps/api`, `apps/cli`) become `apps/*` packages when they are written.

Read the root `CLAUDE.md` first for the product, the loop invariant, and the
provider-agnostic constraint. This file covers only what is true inside this package.

## Status

Phases 0–3a of `~/.claude/plans/polymorphic-gathering-crown.md` are done: tooling,
boundary gates, the domain model, the engine loop, and Postgres storage with atomic
turns. **No provider package is installed** — that is deliberate, and it is the
evidence the ports hold. Real AI adapters, PDF/audio ingestion, projections, and the
CLI do not exist yet. Add commands below as they land; never document a command that
doesn't exist.

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

Run these from the repo root (they delegate here) or from `packages/core` directly.

```bash
pnpm --filter @requirely/core run typecheck    # tsc --noEmit
pnpm --filter @requirely/core run boundaries   # this package's six rules
pnpm --filter @requirely/core run test         # vitest run
pnpm --filter @requirely/core run test:watch

pnpm db:generate   # regenerate migrations from schema.ts — review the SQL diff
pnpm db:migrate    # apply migrations to DATABASE_URL
pnpm db:studio     # drizzle studio

# a single test file
pnpm --filter @requirely/core exec vitest run src/config/env.test.ts
```

## cwd is load-bearing here

Four paths resolve against `process.cwd()`, so **every process touching this package
must run with `cwd = packages/core`**. `pnpm --filter` guarantees that; nothing else does.

| Path | Where |
| --- | --- |
| `migrationsFolder: './drizzle'` | `src/adapters/storage/postgres/client.ts` |
| `migrationsFolder: './drizzle'` | `src/adapters/storage/postgres/testing.ts` |
| `schema: './src/…/schema.ts'`, `out: './drizzle'` | `drizzle.config.ts` |
| `loadEnvFile(path = '.env')` | `src/config/env.ts` — resolves against cwd, and swallows a missing file, so a mis-pathed `.env` is indistinguishable from an absent one |

Consequences:

- **vitest config is per-package, not a root `projects` config.** Vitest 4 does not
  `chdir` per project (verified: no `process.chdir` in the installed package), so a
  root-level run would resolve `./drizzle` to the repo root and fail every PGlite test
  inside `migrate()`.
- **Root `db:*` scripts are `--filter` delegations, never direct invocations.** A root
  `drizzle-kit generate` would write `out: './drizzle'` to the repo root, creating a
  second, divergent migration history while the real one sits untouched.
- **`client.ts` is production code.** The first server-side consumer not launched from
  this directory will hit this for real. The fix when that happens is
  `join(import.meta.dirname, '../../../../drizzle')`, not a cwd convention.
- **The root `.env` is not found by default.** `loadEnvFile()` with no argument looks in
  `packages/core`. Entry points should pass an explicit module-relative path — they are
  the only code that knows where they sit. Nothing calls it yet.

## Toolchain constraints worth knowing before writing code

- **Node 24 runs `.ts` directly** via type stripping, so relative imports must carry the
  `.ts` extension (`import { x } from './x.ts'`).
- **Only erasable TypeScript compiles** (`erasableSyntaxOnly`): no `enum`, no constructor
  parameter properties, no `namespace`. Use `as const` objects with a derived union type
  instead of `enum`, and assign class fields in the constructor body.
- `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on. Optional fields that
  can genuinely be absent are declared `foo: T | undefined`, not `foo?: T`.
- These three live in `packages/core/tsconfig.json`, **not** in the root
  `tsconfig.base.json`, because each is a claim about Node's type-stripping runtime and
  would be actively wrong for a bundled React package. The base carries strictness only.

## Enforced architectural boundaries

Two gates enforce the provider-agnostic constraint, because a rule that lives only in
prose decays silently:

- `pnpm boundaries` (`scripts/check-boundaries.sh`) — the CI gate. Six `report()` calls
  covering five documented rules (the domain third-party rule is two checks: production
  files, and test files which may additionally use `vitest`).
- Biome `noRestrictedImports`, scoped per-directory in `biome.json` `overrides` — the
  editor gate, for feedback while typing.

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

## The `exports` map is deliberately one entry

```json
"exports": { "./domain": "./src/domain/index.ts" }
```

`src/domain/` depends on nothing but `zod` and has no `node:` imports, so it is
**isomorphic** — safe to bundle into a browser. `engine/`, `adapters/`, `config/` and
`ingestion/` are Node-only.

**The absence of a `"."` export is load-bearing.** A barrel would let `apps/web` write
`import … from '@requirely/core'` and drag `postgres` and `@electric-sql/pglite` into the
client graph — the exact leak the boundary apparatus exists to prevent.

Verified 2026-08-19: `apps/web` importing `@requirely/core/domain` typechecks, builds and
executes at prerender time under Turbopack, **without** a `transpilePackages` entry for
core. The one thing it needs is `allowImportingTsExtensions: true` in
`apps/web/tsconfig.json` — not for the app's own code, but because there is no TS project
boundary, so `tsc` checks core's files with the app's config and core's files carry `.ts`
specifiers.

When `apps/api` arrives, add Node-only subpaths guarded by conditions:
`"./engine": { "node": "./src/engine/loop.ts", "default": null }`. The `null` makes a
client-side import fail at build time rather than shipping Postgres to a browser.

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
