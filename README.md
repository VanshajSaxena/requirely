# Requirely

Requirely turns a messy pile of product context into a spec a coding agent can build from. You give it notes, documents and answers, and it asks about whatever is still open. The model doesn't get to decide when it knows enough. Three rules, counted over what it has written down, decide that.

## Status

Shelved. I worked on it from August to September 2026 and stopped with the biggest gap written down rather than fixed.

The first turn on real input is good. On an 11 KB spec it settled five to eight decisions straight from the text and asked four useful questions. The loop after that doesn't close yet. Given four real answers, the second turn on that spec settled nothing. On a short brief it did try to settle, and the domain rejected the whole turn because the model put a question id where a source id belonged. Both runs, and what I'd try next, are in [docs/WEAKNESSES.md](docs/WEAKNESSES.md). Until that's fixed, "Requirely gathers requirements end to end" is unproven.

What does work: the CLI runs a full session against Anthropic, OpenAI or Google, or against a recorded script, stores everything in Postgres, and renders three documents. A DeepSeek adapter exists but has never made a live call. The web app is an empty Next.js shell. Audio goes through OpenAI transcription and is off by default. Code ingestion doesn't exist.

## How it works

1. You start a session and add sources: text, PDF or DOCX.
2. A turn makes three model calls. `analyze` returns a delta, a flat list of ops against the stored understanding, instead of rewriting the document. `assess` scores coverage across eight dimensions, such as users, constraints and acceptance. `generate-questions` asks about what's open, with options, and every option says what choosing it commits you to.
3. Your answers settle open items into Decisions. Requirements, constraints, assumptions and contradictions are the uncertain tier. Decisions are the settled one, and they are never edited or deleted: a new Decision supersedes the old one, so the trail is the history.
4. After every turn the domain records a verdict. The session is sufficient, still awaiting answers, stalled (two turns settled nothing new) or exhausted (out of question budget).
5. `generate` renders an SRS, a requirements document or a prompt for a coding agent. These are pure functions over the stored revision with no model call, so a document can't contain a requirement that was never captured. Each Decision renders with the options that were rejected, because "why not X?" is the question a spec usually can't answer.

## Ideas I'd carry into anything else

Most of these come with a measurement. The full reasoning is in [docs/DECISIONS.md](docs/DECISIONS.md), and the things that cost me hours are in [docs/TRAPS.md](docs/TRAPS.md).

### The model doesn't grade its own homework

The first sufficiency check took per-dimension coverage scores from the same model whose work was being judged and compared them to a threshold. That can only ever be wrong in the flattering direction. Now three rules, counted over the stored document, decide:

1. No blocking open items.
2. Every required dimension (five of the eight by default) has at least one current Decision behind it.
3. At least as many Decisions as uncertain items.

Rule 2 is the one that matters. A ratio on its own is gameable: settle your only requirement and you're at 100% after turn one. The model's coverage score still exists, but it only orders the next questions. [Sufficiency is counted, not scored.](docs/DECISIONS.md#sufficiency-is-counted-not-scored-phase-8)

### Ids a model can tell apart

Ids started as UUIDv7s like `req_01a0148f-aca4-724e-bcb5-50201e28a940`. UUIDv7 starts with a millisecond timestamp, so ids minted in one batch shared about 28 leading characters, which is great for a database index and too alike for a model to tell apart. Five of the seven id types a model emits weren't even primary keys. They live inside a JSONB document, so they became `req-1`, `dec-3`, scoped to the document and minted by a counter that never reissues a number.

The rule I took from it: when a model has to reference something, eliminate the reference if you can, then constrain it, then shorten it, and repair it only as a last resort. Here, some references disappeared entirely because the engine could derive them. [Measured and reversed.](docs/DECISIONS.md#two-decisions-that-were-measured-and-reversed)

### Build both and measure

Merging two of a turn's three calls into one was estimated to save about 30%. Both strategies exist behind a config flag, and measuring showed about 4% ([Patterns worth reusing](docs/DECISIONS.md#patterns-worth-reusing)). Timestamps went the same way: I first stored them as `text`, then measured 20k rows in PGlite. `text` forced a sequential scan, accepted `'not a date'`, and sorted a `+05:30` offset wrongly, so the column became `timestamptz(3)`.

### An eval against a fake measures the fixture

A scripted run reports 100% recommendation acceptance, because the script picks option zero and the fixture recommends option zero. That's a fact about the fixture. So the eval has two halves that claim different things: the instrument always runs on the fake and only claims the harness and the arithmetic work, and the readings need a real model or a recording. The metrics are a pure function over data a session already stores, so measuring never costs a schema change. [Evals.](docs/DECISIONS.md#evals-the-instrument-and-the-readings-are-separate-things-phase-8)

### The model's schema is not the domain's schema

Providers compile a strict JSON Schema into a decoding grammar and cap how branchy it can be. The domain's delta schema had 84 optional and 34 union-typed properties. A separate wire format with one `z.codec` between them has 0 and 0, and dropped from 9.9 KB to 1.9 KB. The trick is a sentinel: every field is required and `''` means absent, and for enums `''` is a member of the enum instead of a union with null. A property test checks `decode(encode(x))` equals `x`, so a domain field the wire can't carry fails CI. [The wire.](docs/DECISIONS.md#the-wire-is-a-separate-shape-from-the-domain-phase-8)

### Compute, then commit

`runTurn` makes its model calls and returns a validated `TurnCommit`, and a separate `commit()` writes it in one short transaction. The first loop wrote at five points between model calls, so a failed call left orphaned answers. When a real turn failed against real Postgres later, it wrote nothing.

### A fake as strict as production

Storage has one contract suite that runs against both the in-memory adapter and PGlite. On its first run PGlite passed and the in-memory adapter failed, because `Map.set` silently overwrote a row where Postgres rejected the duplicate key. The fake was more permissive than production, so now it enforces those constraints too.

### Don't anchor the user

Questions can carry a recommendation. The CLI prints the options first and the recommendation after them, and never pre-selects it. Pre-selecting would put the cursor on Requirely's opinion and make every other option a deliberate move away from it. Choosing against it is an ordinary answer, and the evals track the acceptance rate, since a rate near 1.0 would mean Requirely had started making the choices.

### Prompts aren't documentation

Adding a warning about a failure mode to the instructions dropped first-turn decisions from 8 to 1. Rewording it to say what to do instead brought it back to 5, with the same model, input and schema. Naming a failure reads to a model as a warning about the whole operation. ([TRAPS.md](docs/TRAPS.md#a-prompt-that-names-a-failure-mode-suppresses-the-behaviour-near-it))

### Tests passing isn't proof the code runs

Core and CLI are TypeScript that Node runs directly by stripping types, with no build step. Vitest compiles with its own pipeline and will happily run an `enum` that Node rejects, so `pnpm verify` has a separate gate that imports every module under plain Node. Another gate checks import boundaries, so vendor SDKs stay inside the adapters and the domain depends on nothing but Zod.

## Running it

You need Node 24.12 or newer, pnpm 11 or newer, and Docker for Postgres.

```sh
pnpm install
cp .env.example .env
pnpm verify
```

`pnpm verify` runs typecheck, lint, the boundary and Node checks, and 530 tests. Eight more are live model tests that skip without API keys or recordings. Some CLI tests fail if `.env` is missing.

A whole session costs nothing with a recorded script:

```sh
pnpm db:up
export PATH="$PWD/bin:$PATH"
F=apps/cli/fixtures
echo "I want to see what rooms are free and book one." > /tmp/brief.txt
ID=$(requirely new --title Roomly --provider fake --script $F/roomly.json | sed -n 's/^Created //p')
requirely add      "$ID" /tmp/brief.txt     --provider fake --script $F/roomly.json
requirely turn     "$ID"                    --provider fake --script $F/roomly.json
requirely answer   "$ID" --auto             --provider fake --script $F/roomly-settle.json
requirely generate "$ID" --target agent-prompt --provider fake --script $F/roomly-settle.json
```

To use a real model, put a key in `.env` and drop the `--provider fake --script` flags. [docs/RUNNING.md](docs/RUNNING.md) has the rest, including what to do when port 5432 is taken and where each run's full prompts are logged.

## Where things are

```
apps/cli         the CLI, the only working front door
apps/web         Next.js, a shell
packages/core    the engine: domain, loop, adapters, storage, projections
packages/ui      design system for the web app
docs/            plan, decisions, traps, weaknesses, running
requirely.md     the original product spec
```

I built Requirely with Claude Code. The `CLAUDE.md` and `AGENTS.md` files are the rules it worked under, kept next to the code they're about.

## License

MIT. See [LICENSE](LICENSE).
