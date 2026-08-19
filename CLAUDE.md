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

## Repository shape

A pnpm workspace. **`apps/` vs `packages/` is not frontend vs backend** — it is *has an
entry point you deploy* vs *is imported by something else*. The test question for a new
package is "how many things import this?" One → it can live inside that thing. Two or
more → it is a library.

```
requirely/
├── apps/
│   └── web/          Next.js — the only deployable today
├── packages/
│   ├── core/         the engine: domain, loop, adapters, ingestion, config
│   └── ui/           the design system
├── docker-compose.yml   Postgres for local development
├── requirely.md         the product spec — source of truth for scope
├── tsconfig.base.json   strictness only; no package's runtime assumptions
└── biome.json           root config; packages nest with {"extends": "//"}
```

`packages/core` is **not "the backend"** — it is Requirely's brain. The HTTP server will
be one mouth and the CLI another; both become `apps/*` wrapping the same library. Calling
it "backend" would also mislabel its most reusable third: `src/domain/` depends on nothing
but `zod` and has no `node:` imports, so it is **isomorphic** and safe to bundle into a
browser. That is what lets `apps/web` share the real `Question`/`Answer` schemas and the
real `validateAnswer` instead of a hand-maintained copy that drifts.

Each package has its own `CLAUDE.md` with what is true inside it. Read the relevant one
before working there.

## Commands

```bash
pnpm verify        # typecheck + lint + boundaries + test — the whole gate
pnpm verify:build  # clean build + assert the emitted artifacts (see below)
pnpm typecheck     # tsc --noEmit in every package
pnpm lint          # biome check .   (pnpm lint:fix to apply)
pnpm boundaries    # both boundary scripts
pnpm test          # vitest run in packages/core

pnpm dev           # next dev
pnpm build         # next build
pnpm start         # serve the build

pnpm db:generate   # regenerate migrations from schema.ts — review the SQL diff
pnpm db:migrate    # apply migrations to DATABASE_URL
pnpm db:studio     # drizzle studio
docker compose up -d   # Postgres for local development (tests use PGlite instead)
```

**Root scripts fan out with one explicit `--filter` per package, never `pnpm -r`.**
Measured on pnpm 11.20.0: `-r run X` fails loudly only when *zero* packages have `X`;
when some have it and some do not, the rest are **skipped silently with exit 0** — so a
package could sit outside the gate forever. `--filter <pkg> run <missing>` exits 1.
Adding a package therefore means editing the `typecheck` line, which makes "is it in the
gate?" a reviewable diff rather than an emergent property. Never use `--if-present` in
`verify`. `--fail-if-no-match` exists but does not help: it guards against no *project*
matching the filter, not against a matched project lacking the script. Verified —
`pnpm -r run dev` runs only `apps/web` and exits 0.

## Environment

One `.env` at the repo root, next to the `docker-compose.yml` whose credentials
`DATABASE_URL` must match. `.env.example` documents it.

`apps/web` keeps its own `.env.local` — **not** for tidiness. The frontend has no business
being able to read `ANTHROPIC_API_KEY`. `NEXT_PUBLIC_` prefixing stops secrets reaching the
browser, but it does not stop a server component reading one and rendering it. A secret
absent from the app's environment cannot leak from it.

Caveat recorded in `packages/core/CLAUDE.md`: `loadEnvFile(path = '.env')` resolves against
`process.cwd()`, so it does **not** find the root file by default from inside a package.
Entry points should pass an explicit module-relative path. Nothing calls it yet.

## Toolchain sharp edges

- **pnpm 11 ignores the `pnpm` field in `package.json`** — settings live in
  `pnpm-workspace.yaml`, and putting them back in `package.json` only produces a warning.
  `esbuild` (drizzle-kit's dependency) needs **both** `onlyBuiltDependencies` and
  `allowBuilds` set there, or `pnpm install` exits non-zero.
- **`publicHoistPattern: [drizzle-orm]` is load-bearing.** drizzle-kit's `bin.cjs` does a
  bare `await import("drizzle-orm/version")`, which Node resolves from **bin.cjs's own
  realpath** inside `.pnpm/` — not from cwd, and not from the workspace package that
  depends on it. As a single package this worked by accident, because `drizzle-orm` was a
  root dependency. After the split it failed with *"Please install latest version of
  drizzle-orm"* — a message that names the wrong problem entirely.
- **Changing hoist settings makes `pnpm install` want to purge `node_modules`**, which it
  refuses to do without a TTY. `CI=true pnpm install` in a non-interactive shell — but note
  `CI=true` also implies `--frozen-lockfile`, so add `--no-frozen-lockfile` when
  dependencies changed.
- **Biome nested configs must be `{"extends": "//"}`.** Writing `{"extends": "../../biome.json"}`
  makes the file a second *root*: discovery breaks and that package's rules silently never
  run during `pnpm lint`. Note the two different merge semantics — `extends` deep-merges,
  while `overrides` entries **replace** each other per rule.
- **Biome rejects unknown rule names in config** rather than ignoring them, which is how a
  wrong guess gets caught immediately. Tailwind v4's at-rules need
  `css.parser.tailwindDirectives: true` — a *parser* option, not a lint rule to disable.
- **Every boundary script must abort, not pass, when its target directories are missing.**
  Both helpers return silently on a missing directory, so a wrong cwd would otherwise print
  "Boundary check passed" while checking nothing.
- **Node refuses to type-strip any file whose *realpath* is under `node_modules`**
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). `packages/core` is Node-runnable only
  because pnpm symlinks it out to `packages/core`. Breaks at **runtime** under
  `pnpm deploy`, `--preserve-symlinks`, `node-linker=hoisted`, and any Docker layout or
  publish that copies the package. `apps/web` is immune — Next bundles rather than strips.
  The trigger and the config-only fix are recorded in `packages/core/CLAUDE.md`.
- **Tailwind's source detection is rooted at `process.cwd()`, and a wrong `@source` path is
  a silent no-op** — no error, no warning, just unstyled components. Each package therefore
  declares only its own sources, and `pnpm verify:build` asserts the emitted CSS.
- **Turbopack's incremental cache can make `pnpm verify:build` pass on stale output.**
  Measured: a deliberately broken `@source` passed every check with a warm `.next` and
  failed all three CSS checks after `rm -rf`. That is why `verify:build` removes `.next`
  first — it is correctness, not tidiness.

## Enforced architectural boundaries

Two scripts, deliberately not one parameterized script — the rule sets are disjoint, and a
`case "$1"` dispatch would make a typo'd argument a new way to get a silent pass.

| Script | Covers |
| --- | --- |
| `packages/core/scripts/check-boundaries.sh` | hexagonal layering inside core, the zero-third-party allowlist for `domain/`, AI-SDK containment, determinism |
| `scripts/check-frontend-boundaries.sh` | no server-only deps in the browser graph; `apps/` may reach only `@requirely/core/domain`; `packages/ui` knows no domain, no `apps/`, no `node:` |

A third script, `scripts/check-frontend-artifacts.sh`, is **not** part of `pnpm boundaries`
— it needs a build, so it runs under `pnpm verify:build`. It asserts what no static check
can see: that `/` actually prerendered, that the design system's Button reached the HTML,
and that a utility used *only* in `packages/ui` survived into the app's CSS. That last one
is the only detectable signal for a broken Tailwind cross-package scan, which otherwise
fails silently.

Both run under `pnpm boundaries`, and both **must fail CI** — a rule that lives only in
prose decays silently. After changing either, re-prove it by planting deliberate violations
and confirming each rule fires, including the negative controls.

The frontend script greps `--include='*.ts' --include='*.tsx'`. `--include` is repeated,
not merged, and the original core script passed only `*.ts` — invisible while the repo had
no JSX, but in a React codebase it would make every rule pass vacuously in every `.tsx`
file. Both scripts now cover both.

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
