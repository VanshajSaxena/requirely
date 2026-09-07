# Running Requirely locally

From a clean clone to a generated SRS. Everything here has been executed on a
real machine against real Postgres; where something is known to be rough, it says
so rather than leaving you to find out.

Read [PLAN.md](PLAN.md) for what the product is. This file is only how to run it.

---

## 1. Prerequisites

Node **≥ 24.12** (type stripping must be stable), pnpm 11, Docker.

```sh
pnpm install
```

### Docker: the group has to be active in *this* shell

If `docker info` says `permission denied ... /var/run/docker.sock`, your user is
not in the `docker` group **in the shell you are using**. Group membership is
granted at login, so adding it to your system configuration does not affect a
shell that was already open:

```sh
newgrp docker           # interactive shell
sg docker -c '<cmd>'    # one non-interactive command
```

## 2. Start Postgres

```sh
pnpm db:up          # up, wait for healthy, migrate — or explain why it could not
pnpm db:reset       # same, but destroys the volume first
pnpm db:down        # stop
```

### If port 5432 is already taken

Common on Linux, where a distro or Nix module may already run Postgres as a
service. `pnpm db:up` detects this and tells you; the fix is to move **our**
container rather than to stop **your** server. Set both values in `.env`:

```
REQUIRELY_DB_PORT=5433
DATABASE_URL=postgres://requirely:requirely@localhost:5433/requirely
```

`docker compose` reads that same `.env`, so nothing else needs changing.

## 3. Get a `requirely` command

```sh
./bin/requirely --help
```

`bin/requirely` resolves through the repo, which matters: `packages/core` is
source-only TypeScript that Node executes by stripping types, and Node refuses to
strip any file whose **realpath** is under `node_modules`. Running through the
source tree keeps that from ever becoming a question. Put it on your PATH:

```sh
export PATH="$PWD/bin:$PATH"
```

`pnpm cli -- <args>` also works, as does `node apps/cli/src/main.ts <args>`.

## 4. A real session

```sh
requirely new --title "My product"          # prints a session id
requirely add <id> ./notes.md               # text, PDF, DOCX
requirely turn <id>                         # analyse, assess, ask
requirely answer <id>                       # interactive
requirely status <id>                       # free — no model call
requirely generate <id> --target srs --out spec.md
```

`--target` is one of `srs`, `requirements-doc`, `agent-prompt`.

### Cost

`.env` ships `REQUIRELY_REASONING_MODEL=claude-opus-5`. For everyday runs pass a
cheaper model on the command line rather than editing the committed default:

```sh
requirely turn <id> --model claude-haiku-4-5
```

Every turn prints its own token count and cost, and `Turn` stores `usage`, so
"what did this session cost" stays answerable from the database afterwards.

## 5. A whole session for free

`--script` drives the loop from a recorded file instead of a model. Note that
`--provider fake` **on its own does nothing useful** — the registry builds an
empty script, so the first call fails. See
[`apps/cli/fixtures/README.md`](../apps/cli/fixtures/README.md) for why there are
two fixture files.

```sh
ID=$(requirely new --title Roomly --script apps/cli/fixtures/roomly.json | sed -n 's/^Created //p')
echo "I want to see what rooms are free and book one." > /tmp/brief.txt
requirely add    "$ID" /tmp/brief.txt   --script apps/cli/fixtures/roomly.json
requirely turn   "$ID"                  --script apps/cli/fixtures/roomly.json
requirely answer "$ID" --auto           --script apps/cli/fixtures/roomly-settle.json
requirely generate "$ID" --target srs   --script apps/cli/fixtures/roomly-settle.json
```

`--auto` takes the first option every time. It proves the pipeline and nothing
about the content — it makes no choice worth trusting.

---

## Things that will surprise you

**`generate` finalizes the session, and finalizing is one-way.** `finalizeSession`
goes through `assertTransition`, so `finalized` is reachable only from
`sufficient` or `exhausted`, and a finalized session cannot take another `turn`.
Generate every target you want in one sitting, or start a new session.

**Turn 2 will probably return an empty delta against a real model.** Reproduced
twice live, across two prompt variants: you answer the questions, the answers are
stored correctly, and the next turn settles nothing. The plumbing is proven — the
fake-backed integration test folds answers in and promotes correctly — so this is
a prompt problem, not a wiring one. Two causes are identified and unfixed by
choice: `ANALYZE_INSTRUCTIONS` never states that an answered question is a
settling event, and `buildAnalyzeInput` puts answers **third of four** blocks,
behind an understanding that is by then the largest thing in the prompt. Tracked
in [WEAKNESSES.md](WEAKNESSES.md).

**`--memory` cannot carry a session between commands.** Each command is a
process. It is for a single-process test, and it is honest about forgetting,
which a silent in-memory default would not be.

**Audio ingestion is off.** `REQUIRELY_TRANSCRIPTION_PROVIDER=none`, so
`ingestAudio` fails with a clear message. Set it to `openai` and supply
`OPENAI_API_KEY` to enable it. `fake` exists for tests and invents transcripts —
never point a real session at it.

---

## Checks

```sh
pnpm verify        # typecheck, lint, boundaries, node-runnable, tests
pnpm verify:build  # clean build + assert the emitted frontend artifacts
```

`pnpm test` passing is **not** evidence that Node can run this code — vitest uses
its own transpiler and will happily execute syntax Node rejects. That is what
`pnpm node-runnable` is for, and why it is a separate gate.
