# CLAUDE.md — @requirely/cli

The front door. Node runs `src/main.ts` directly; there is no build step.

Read the root `CLAUDE.md` for the product and the loop invariant, then
`packages/core/CLAUDE.md` for what the engine guarantees. This file covers only
what is true inside this app.

## What this is, and is not

**A playground, not the product.** It exists to exercise the engine end to end
and to be the first real consumer of core's published surface. Investment goes
into the answer UX — the one place the spec's low-effort / high-flexibility
promise actually shows up — and nowhere else.

It is also the app that proves `packages/core` exports **pieces, not a runtime**.
If a `createRuntime()` ever appears in core, this package is what will have made
it seem reasonable, so it is worth being suspicious of any convenience that
starts here and migrates inward.

## Orientation

- **`compose.ts` is the composition root, and the only one.** Provider choice,
  decorator stack, storage, lifetime. `apps/api` will make different choices in
  its own file. Nothing else in this package constructs an adapter.
- **`committer` is deliberately outside `EngineDeps`.** `runTurn` reads, calls
  models and returns a `TurnCommit` without writing; committing is a separate
  visible step. Keeping the committer out of what `runTurn` receives is what
  makes "the loop cannot write" unexpressible rather than merely true.
- **`asker.ts` is a port.** Asking a human is I/O, so it gets the same treatment
  as asking a model — which is what makes a full session testable with a scripted
  answerer and zero spend.
- **Commands group by layer**, not one file per verb: `session.ts` (new/ls/status),
  `add.ts` (ingestion), `turn.ts` (turn/answer), `generate.ts` (projection). That
  is the seam the rest of the codebase is organised along.
- **`render.ts` is pure.** Output is testable without capturing stdout, and the
  wording is not trapped inside argument parsing.
- **`status.ts` / `observe.ts` / `runlog.ts` are the diagnostic channel**, and
  all three write to **stderr**. `observe.ts` turns core's `CallEvent`s into a
  live phase line, a permanent timeline and a JSONL run log; `compose.ts` fans
  one stream out to all three. Core emits facts with no timestamps — the sink
  stamps arrival — so the renderers are driven from literals in tests.

## Load-bearing details

- **The recommendation is never a pre-selection.** `clack.select` takes an
  `initialValue`; using it for `Question.recommends` would put the cursor on our
  opinion and make every other option a move away from it. `renderQuestion`
  prints the options first and the recommendation after, with its reasoning. A
  test rejects the recommendation and asserts the loop treats it identically.
- **Answer ids come from `ids.next('answer')`.** A per-turn counter collides
  across a persisted session — the trap Phase 7 predicted and a Phase 8 test hit
  for real.
- **`validateAnswer` runs at the prompt**, before any model call. Discovering a
  malformed answer inside `runTurn` means the user is told after paying for three
  calls.
- **`loadEnvFile` is given an explicit path.** It resolves against `process.cwd()`
  and swallows a missing file, so an unqualified call would silently see no
  configuration from anywhere but `packages/core`.
- **Postgres is the default; `--memory` is explicit and single-process.** Commands
  are separate processes, so an in-memory default means `new` prints an id the
  next command cannot find.
- **Connection failures are translated here**, with the password redacted. Core
  is right not to guess at a remedy; it does not know a `docker-compose.yml`
  exists.
- **`redact` and `redactSecrets` are two functions that read alike and behave
  oppositely.** `redact(url)` parses its whole argument as a URL and returns
  `(unparseable DATABASE_URL)` for anything that is not one — right for the
  connection-failure message, catastrophic for a log line, where it would
  replace every record with that string. `redactSecrets(text)` blanks an
  embedded credential inside a larger body and leaves the rest alone.
- **`main.ts` clears the status line before its single stdout write**, and
  `close()` clears it again. A frame redrawing on a 100 ms timer will otherwise
  land across the command's output or be left half-drawn at exit.
- **The status line is not the same as a quiet one.** Non-interactive selects a
  one-line-per-phase *fallback*; `silentStatusLine` says nothing. `--quiet`
  wants the second, and wiring it to the first is a bug that printed a phase
  line per step into the test suite.

## Boundaries

`scripts/check-frontend-boundaries.sh` rules 12 and 13, both proved with planted
violations:

- may import `@requirely/core/domain` or `@requirely/core/server` and **nothing
  deeper** — including via a relative path, which the `exports` map cannot see;
- may not import `ai` / `@ai-sdk/*`. Providers live behind a port, and this is
  the first layer with somewhere to leak them to.

Rules 7 and 8 name `apps/web` explicitly, so a CLI importing `postgres` is fine.

## Commands

```bash
pnpm --filter @requirely/cli run typecheck
pnpm --filter @requirely/cli run test
./bin/requirely --help                   # or `pnpm cli -- --help`

# a real session, once Postgres is up
pnpm db:up
requirely new --title "Roomly"
requirely add <id> ./brief.md
requirely turn <id>
requirely answer <id>
requirely generate <id> --target srs --out spec.md

# the whole loop, no spend, across real processes
requirely turn <id>   --script apps/cli/fixtures/roomly.json
requirely answer <id> --auto --script apps/cli/fixtures/roomly-settle.json
```

See [docs/RUNNING.md](../../docs/RUNNING.md) for setup and the surprises.

## Two things about running it that are not obvious

- **`--provider fake` on its own is inert.** `adapters/registry.ts` builds
  `fakeStructuredGenerator()` with an *empty* script, so the first `analyze`
  call fails. That is the right default — a fake that invented plausible
  requirements would be the same lie this codebase refused when it chose a
  `none` transcription provider over a `fake` one. `--script <file>` is how you
  supply the script; `fixtures/README.md` explains why there are two files.
- **`main.ts` strips one leading `--`.** pnpm forwards `--` verbatim through a
  nested `run`, so `pnpm cli -- --help` arrived as `['--','--help']` and
  `parseArgs` turned `--help` into a positional. `pnpm exec` does the same, so
  the fix has to be in the entry point.
