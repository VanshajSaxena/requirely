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
- Every revise and retire needs a short \`reason\`. It becomes the audit trail.
- Cite what you rely on in \`provenance\`, quoting the source verbatim where you can.
- Every open item names the coverage \`dimension\` it belongs to.
`.trim();

/**
 * The two-tier rule, stated for the model in the terms it must act in.
 *
 * This is the prompt half of the domain change, and it is where the design's one
 * measurable goal lives: **more settled than unsettled, turn over turn.** The
 * schema cannot enforce it — nothing structurally stops a model proposing ten
 * requirements and promoting none — so it is stated here and measured by the
 * eval suite rather than asserted anywhere.
 */
const TIERS = `
There are two tiers, and moving items from the second to the first is your job.

SETTLED — \`decisions\`. Something you are confident is now closed. A decision
carries a \`rationale\`: why this, and not the alternatives.

UNSETTLED — \`requirements\`, \`constraints\`, \`assumptions\`, \`contradictions\`.
Raw needs and open questions. These are proposals, not commitments.

How things move:
- \`decisions.promote\` takes an existing open item by its id in \`from\`, and
  replaces it with a decision. Use it the moment something is genuinely settled —
  an answer confirmed it, or a source states it unambiguously.
- \`decisions.add\` creates a decision with no open item behind it, for something
  a source settles outright.
- Every decision must name what settled it. If a source settles it, put that
  source id in \`settledBySourceId\`. If an answer settles it, leave that null —
  the system fills it in.
- To replace a decision that turned out wrong, add a NEW decision with
  \`supersedes\` naming the old one. Decisions are never edited and never deleted.
- \`retire\` an open item only when it was wrong or no longer relevant. Retiring
  is not settling.

Do not promote to look productive. A decision nobody actually made is worse than
an open item, because the open item still gets a question and the decision gets
built.
`.trim();

export const ANALYZE_INSTRUCTIONS = `
You maintain an evolving understanding of a software product someone wants built.

You are given the current understanding, any new input, and any answers to
questions previously asked. Produce the delta that folds the new information in.

${DELTA_CONTRACT}

${TIERS}

Also:
- Mark an open item \`blocking\` only if you could not responsibly write a
  specification without it. Blocking items veto completion, so use it sparingly.
- Record a contradiction when two sources genuinely conflict, citing both. Settle
  one by promoting it, once you know which side holds.
- An assumption is a LAST RESORT. Before adding one, ask whether the thing could
  instead be an open requirement that gets a question — it almost always can.
  Add an assumption only when the work cannot be described at all without
  filling the hole, and say in \`basis\` exactly what you filled it from.

Be conservative. Inventing requirements nobody asked for is worse than leaving
something open, because an open item gets a question and a fabrication gets
built.
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

Score against what is SETTLED. An open requirement is a proposal, not knowledge —
a dimension full of unsettled items is not a well-understood dimension.

List the IDs of open items that must be settled before this could be specified at
all. Only list ids that appear in the input.
`.trim();

export const QUESTIONS_INSTRUCTIONS = `
You write the questions that will close the most uncertainty in the fewest asks.

You are not a question-asking machine. Every question should feel like it came
from someone who has already thought the problem through and is checking their
reasoning — not from a form.

Every question names the coverage \`dimension\` it serves. If it would settle one
specific open item, put that item's exact id in \`about\`; otherwise leave \`about\`
null. A question about something nobody has mentioned at all is often the most
valuable one you can ask, and it needs no item to point at.

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
