# Fixtures — driving the loop without spending anything

`--provider fake` on its own is inert: `packages/core/src/adapters/registry.ts`
builds `fakeStructuredGenerator()` with an **empty** script, so the first
`analyze` call fails. That is the right default — a fake that invented plausible
requirements on demand would be the same lie this codebase already refused when
it chose a `none` transcription provider over a `fake` one. What was missing is a
way to *supply* the script. That is `--script`.

```
requirely turn <id> --provider fake --script apps/cli/fixtures/roomly.json
```

The script is validated against the real domain schemas by the fake generator
itself, so a fixture that drifts fails exactly as a real model's malformed output
would. `session.test.ts` additionally asserts these bytes equal the script its
own tests run, so the file a user reaches for is the file the tests prove.

## Why there are two files

**A CLI command is a process, and a script queue does not outlive one.** The fake
serves responses per `operation` in order, and every command starts a fresh
process at index 0 — so a two-command session replays turn 1 twice rather than
advancing. That is a property of scripting a multi-process CLI, not a defect.

| File | `analyze[0]` | Use it for |
| --- | --- | --- |
| `roomly.json` | proposes two open requirements | `turn` — the first pass, which ends `awaiting-answers` |
| `roomly-settle.json` | promotes both and adds three decisions | `answer` — the second pass, which reaches `sufficient` |

A full terminal session at zero cost:

```sh
F=apps/cli/fixtures
ID=$(requirely new --title Roomly --provider fake --script $F/roomly.json | sed -n 's/^Created //p')
requirely add      "$ID" ./brief.txt    --provider fake --script $F/roomly.json
requirely turn     "$ID"                --provider fake --script $F/roomly.json
requirely answer   "$ID" --auto         --provider fake --script $F/roomly-settle.json
requirely generate "$ID" --target srs   --provider fake --script $F/roomly-settle.json
```

`session.test.ts` runs the equivalent in **one** process, where `roomly.json`
alone carries both turns. Both are true; they differ only in how many processes
the queue has to survive.
