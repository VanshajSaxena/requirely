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

Or change provider entirely. `--provider` takes `anthropic`, `openai`, `google`,
`deepseek` or `fake`, each reading its own key from `.env` (`GOOGLE_API_KEY`,
`DEEPSEEK_API_KEY`, …). Cost varies by roughly an order of magnitude:

```sh
requirely turn <id> --provider google --model gemini-flash-latest
```

Two honest caveats. **Anthropic, OpenAI and Google are priced; DeepSeek is not**,
so a DeepSeek session reports "cost unknown" rather than a number — a missing
figure is questioned and a guessed one is believed. And **DeepSeek has no
schema-constrained decoding**, so it degrades to tool mode automatically; that
path works and is less guarded than the constrained one.

Every turn prints its own token count and cost, and `Turn` stores `usage`, so
"what did this session cost" stays answerable from the database afterwards.

## 5. A whole session for free

`--script` drives the loop from a recorded file instead of a model. Note that
`--provider fake` **on its own does nothing useful** — the registry builds an
empty script, so the first call fails. See
[`apps/cli/fixtures/README.md`](../apps/cli/fixtures/README.md) for why there are
two fixture files.

The reverse also holds: `--script` needs `--provider fake` beside it. Without
it, every command still loads the provider configured in `.env` and, on a fresh
clone with no API key, stops before doing anything.

```sh
F=apps/cli/fixtures
ID=$(requirely new --title Roomly --provider fake --script $F/roomly.json | sed -n 's/^Created //p')
echo "I want to see what rooms are free and book one." > /tmp/brief.txt
requirely add      "$ID" /tmp/brief.txt  --provider fake --script $F/roomly.json
requirely turn     "$ID"                 --provider fake --script $F/roomly.json
requirely answer   "$ID" --auto          --provider fake --script $F/roomly-settle.json
requirely status   "$ID"                 --provider fake
requirely generate "$ID" --target srs    --provider fake --script $F/roomly-settle.json
```

`--auto` takes the first option every time. It proves the pipeline and nothing
about the content — it makes no choice worth trusting.

## 6. Watching a turn, and reading it afterwards

A turn is two or three provider calls and can run for minutes. It narrates
itself on **stderr**, so everything below stays out of a redirected document.

```
⠹ Analysing input · 18s                      ← while it runs, redrawn in place

● analyze  openai/gpt-5.6-luna  constrained  ← and then permanently
  → sent instructions 5.5KB · input 336B · effort high
  ← 18s  1,487 out  $0.0021
```

`method` is worth watching. In the run above, `analyze` and `assess` went out
`constrained` and `generate-questions` stepped down to `tool` — OpenAI permits no
optional properties under strict decoding, and question drafts have six.

| Flag | Effect |
| --- | --- |
| *(none)* | status line, per-call timeline, run log |
| `--verbose` | adds the method-choice reasoning and a 400-character preview of what was sent and what came back |
| `--quiet` | errors only. Also what a non-TTY gets for the status line: one plain line per phase, never a redraw |

`LOG_LEVEL` in `.env` sets the floor for the `[level] message` diagnostics;
`--verbose` overrides it to `debug`.

### The run log

Every turn that calls a provider writes its payloads to
`.requirely/runs/<timestamp>-<session>/`:

- **`calls.jsonl`** — one JSON object per event. For each call: the full system
  prompt, the full input, the JSON Schema, the provider options, then the value,
  usage, timing, `finishReason` and any provider warnings.
- **`turn.json`** — the verdict and the turn's totals.

The last 20 runs are kept. `REQUIRELY_RUN_LOG_DIR` moves the directory; the
default is repo-relative, like `.env`, so it does not follow you between working
directories. `.requirely/` is gitignored.

> **It holds your material.** The prompts, your sources, your answers and the
> model's output, in full. No API key can reach it — keys live on the adapter
> config and never enter an event — and an embedded database password is
> redacted. Everything else is verbatim, so read a run directory before you
> paste one anywhere.

A `--script` run writes **nothing**: no provider was called, so there is nothing
to record and no empty directory left behind.

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
