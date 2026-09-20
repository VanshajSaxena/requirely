# Requirely Agent Notes

## Read First

- Use Node `>=24.12` and pnpm 11. Install from the repository root with `pnpm install`.
- Read `docs/PLAN.md` for current status and `requirely.md` for product scope. Before changing a
  package, read its `CLAUDE.md`; `packages/core/CLAUDE.md` contains the load-bearing engine rules.
- Check `docs/WEAKNESSES.md` before redesigning a known gap and `docs/TRAPS.md` before changing
  Zod, Drizzle, Biome, pnpm, AI adapters, or runtime/build configuration.
- `apps/` means deployable entry points, not frontend. `packages/` means shared libraries.
  `apps/cli` is a Node entry point; `apps/web` is the browser app.

## Verification

Run commands from the repository root unless noted.

```bash
pnpm verify        # typecheck -> lint -> boundaries -> node-runnable -> core and CLI tests
pnpm verify:build  # delete .next, build web, assert prerendered HTML and emitted UI CSS
```

- `pnpm verify` does not build the web app; run `pnpm verify:build` after frontend, UI, Tailwind,
  Next, or cross-package styling changes.
- Focus a package with `pnpm --filter @requirely/{core,ui,web,cli} run <script>`.
- Run one test file with, for example,
  `pnpm --filter @requirely/core exec vitest run src/config/env.test.ts`; use the same form for
  `@requirely/cli` and a path relative to `apps/cli`.
- Core storage tests use in-process PGlite and do not require Docker. Live model tests/evals may
  skip when credentials or cassettes are absent; do not treat a skipped live reading as validation.
- Root verification names every package explicitly by design. Do not replace its `--filter` chain
  with `pnpm -r` or `--if-present`; pnpm silently skips packages missing a script.

## Architecture Boundaries

- The durable artifact is the structured understanding; SRS, requirements document, and agent
  prompt are pure projections. Sufficiency is an explicit decision in the gathering loop.
- Keep AI providers behind core ports. Vendor SDK imports belong only in
  `packages/core/src/adapters/ai` or `adapters/transcription`; domain and orchestration stay
  provider-agnostic.
- `packages/core/src/domain` is browser-safe and depends only on Zod. Core exports only
  `@requirely/core/domain` and `@requirely/core/server`; `server.ts` must remain re-exports only.
- `runTurn` reads and returns a validated `TurnCommit`; it must not persist. The app commits the
  result separately. Each app owns its composition root; do not add a core `createRuntime()`.
- `packages/core/src/wire` is the model-facing encoding, bridged to the domain by codecs. Do not
  collapse wire and domain schemas or bypass the schema-budget machinery.
- `packages/ui` may not know about core, apps, or Node. `apps/web` may import only
  `@requirely/core/domain`; `apps/cli` may import only core's `/domain` and `/server` surfaces.
- `pnpm boundaries` enforces these rules. If changing a boundary checker, prove each changed rule
  with a temporary violating case and a negative control; missing-directory guards prevent
  vacuous passes.

## Node And TypeScript

- Core and CLI are source-only TypeScript executed directly by Node type stripping; there is no
  build step. Relative imports use explicit `.ts` extensions.
- Only erasable syntax is valid in core/CLI: no enums, namespaces, or constructor parameter
  properties. Vitest transpiles syntax Node rejects, so `pnpm node-runnable` is not redundant.
- Do not use `--preserve-symlinks`, copy core into `node_modules`, or deploy an unbundled consumer
  with injected workspace packages. Node refuses to strip TypeScript whose realpath is under
  `node_modules`; deployable consumers must bundle core.
- Domain records use nullable fields rather than optional fields because `undefined` disappears in
  JSONB. In web/UI component props, use `p?: T | undefined` under exact optional property types.

## Database And Environment

- Copy `.env.example` to the root `.env`. Entry points must pass an explicit path to
  `loadEnvFile`; its default is cwd-relative and silently ignores a missing file.
- Use `pnpm db:up`, `pnpm db:reset`, and `pnpm db:down`. If port 5432 is occupied, change both
  `REQUIRELY_DB_PORT` and `DATABASE_URL` in `.env`.
- Always use root `pnpm db:generate|db:migrate|db:studio`; these filtered scripts supply the
  `packages/core` cwd required by Drizzle config. A direct root `drizzle-kit` command targets the
  wrong migration path.
- Migrations under `packages/core/drizzle` are committed artifacts. Review generated SQL. Drizzle
  cannot detect field changes inside JSONB, so JSONB renames require a hand-written data migration
  and an old-row regression test.

## Frontend And UI

- `apps/web` uses Next 16.3. Read the relevant installed guide under
  `apps/web/node_modules/next/dist/docs/` before relying on remembered APIs.
- Preserve the generated marked block in `apps/web/AGENTS.md` and its `@AGENTS.md` reference in
  `apps/web/CLAUDE.md`; `next dev` recreates them.
- Web typecheck is `next typegen && tsc --noEmit`; use the package script rather than bare `tsc`.
- Tailwind v4 source paths are package-local and silently fail when wrong. Keep UI's `@source`
  declaration and use `pnpm verify:build`, whose clean build avoids stale Turbopack CSS.
- Add shadcn primitives with `pnpm dlx shadcn@latest add <component> --cwd packages/ui`, then run
  `pnpm lint:fix`. Keep `tailwind.config` empty in both `components.json` files.
