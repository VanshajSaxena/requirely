# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

Greenfield. The repo contains only `requirely.md` (the product spec) — no source, dependencies, build, or test tooling yet. Add a Commands section here the moment tooling lands; never document commands that don't exist.

## Product

Requirely turns unstructured input (voice/audio, text, documents, code, conversations, existing requirements) into a complete understanding of what should be built, then projects that understanding into an SRS, a requirements document, or a prompt for an AI coding agent.

Read `requirely.md` before making design decisions — it is the source of truth for scope.

## The invariant that shapes the architecture

The product is the **requirement-gathering loop**, not the document:

`Input → Understand → Identify Gaps → Ask Questions → Receive Answers → Re-evaluate → (repeat if needed) → Finalize`

Consequences to hold when designing anything:

- **Understanding is the durable artifact.** Output formats are projections over it. State must never end up living inside the SRS/prompt generator.
- **Sufficiency is an explicit step.** Each iteration answers "do I have enough to confidently describe what needs to be built?" — that judgement should be an inspectable decision, not an emergent side effect of prompt wording.
- **Questions carry generated answer options** (lowest-effort path) and always accept a custom answer (highest-flexibility path).
- **The output target is optional and late-binding.** A user may declare it upfront ("write an SRS") or pick it after dumping context. Ingestion and analysis must work without knowing the target.
- **Input modality is a mechanism, not an identity.** Voice is a priority input, but nothing below the ingestion boundary may be voice-shaped.
- Ask only the questions needed to reach sufficiency — question volume is a cost, not a feature.

## Hard constraint: provider-agnostic AI

No single AI provider may be baked in. Define clean interfaces per capability (e.g. text generation, structured/JSON output, transcription) and implement swappable per-provider adapters behind them. Different layers may use different providers simultaneously — transcription from one vendor, reasoning from another. Provider SDK types and vendor-specific concepts must not leak into domain or orchestration code.

## Initial scope

Backend only. No polished frontend. The bar for v1 is proving the gathering engine works end to end: ingest → transcribe when needed → analyze → identify gaps → generate questions with options → process answers → re-evaluate → decide completeness → generate the requested output.
