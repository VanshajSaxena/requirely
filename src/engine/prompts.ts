/**
 * Instruction strings, one per operation.
 *
 * Kept in a single file while they are small; split per operation when they grow
 * enough that diffing one hurts. They are `instructions` rather than inline
 * strings at call sites because adapters may cache on that stable prefix, and
 * because prompt changes should show up as a diff in one place.
 *
 * These are written for correctness of *contract*, not yet tuned for quality
 * against a real model — that happens in Phase 4 when cassettes exist to measure
 * against.
 */

const DELTA_CONTRACT = `
You return a DELTA — only what changed. Never restate the whole understanding.

Rules that are enforced in code and will reject your output if broken:
- To change something that exists, put it in \`revise\` with its exact existing ID.
- To add something new, put it in \`add\` WITHOUT an id. Ids are assigned for you.
- Never invent an ID. Referencing an ID that does not exist fails the whole turn.
- In \`revise\`, include only the fields you are changing. Omitted fields are left
  untouched. Send an explicit null only when you mean "this no longer applies".
- Every revise and remove needs a short \`reason\`. It becomes the audit trail.
- Cite what you rely on in \`provenance\`, quoting the source verbatim where you can.
`.trim();

export const ANALYZE_INSTRUCTIONS = `
You maintain an evolving understanding of a software product someone wants built.

You are given the current understanding, any new input, and any answers to
questions previously asked. Produce the delta that folds the new information in.

${DELTA_CONTRACT}

Also maintain gaps:
- Add a gap for anything genuinely missing that would prevent describing what to
  build. Each gap names the coverage dimension it belongs to.
- Mark a gap \`blocking\` only if you could not responsibly write a specification
  without it. Blocking gaps veto completion, so use the flag sparingly.
- When an answer or new source closes an existing gap, put it in \`resolve\` with
  what was learned. Do not leave answered gaps open.
- Record a contradiction when two sources genuinely conflict, citing both.
- Record an assumption whenever you fill something in that nobody stated.

Be conservative. Inventing requirements nobody asked for is worse than leaving a
gap open, because a gap gets a question and a fabrication gets built.
`.trim();

export const ASSESS_INSTRUCTIONS = `
You judge how completely a product is understood — you do NOT decide whether it
is complete enough. That decision is made elsewhere from your scores.

Score each dimension from 0 to 1:
- purpose: what this is and why it exists
- users: who it serves and what they need
- core-behaviour: what the system actually does
- data: what it stores and what shape that takes
- constraints: technical, business, regulatory, operational limits
- edge-cases: failure modes and boundaries
- acceptance: how anyone would know it was built correctly
- integrations: what it must talk to

Score every dimension, including ones you are confident about. A dimension you
omit is treated as zero, not as fine.

Give each score a one-sentence rationale naming the specific evidence or its
absence. "Mostly clear" is not a rationale.

List the IDs of gaps that must be closed before this could be specified at all.
Only list gaps that appear in the input.
`.trim();

export const QUESTIONS_INSTRUCTIONS = `
You write the questions that will close the most uncertainty in the fewest asks.

Every question must target one of the listed open gaps by its exact ID.

Give each question 2 or more answer options when plausible answers exist, ordered
most-likely first. Options are the low-effort path: a user should usually be able
to click rather than write. Give a question zero options only when the space of
answers is genuinely open. Never give exactly one option — that is a leading
question, and it is rejected in code.

Set mode to "single" when the answers are mutually exclusive, "multiple" when
several can hold at once. A custom written answer is always accepted regardless;
you do not need to add an "other" option.

Order your questions most important first — only the first few will be asked.

Ask about what you need to build the thing, not about what would be interesting
to know. Question volume is a cost paid by the user.
`.trim();
