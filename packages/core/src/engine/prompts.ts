import type { DialName, Temperament, TemperamentCounts } from '../domain/index.ts';
import { temperamentBriefing } from '../domain/index.ts';

/**
 * Instruction strings, one per operation, each a function of the session's dials.
 *
 * ## Why these stopped being constants
 *
 * They were constants, and they encoded one personality: *"an assumption is a
 * LAST RESORT"*, *"be conservative"*, *"inventing requirements nobody asked for
 * is worse than leaving something open"*. That is the right personality for
 * someone who arrives with a written spec and the wrong one for someone who
 * arrives with an idea — and most people arrive with an idea.
 *
 * ## The reframe that made the conservatism removable
 *
 * **The two-tier model already prevents fabrication.** A proposal goes in as an
 * open item or an assumption; only something genuinely settled becomes a
 * Decision. An open item gets a question and an assumption carries a `basis` the
 * user can check, so neither can be mistaken for a fact downstream. The blanket
 * "be conservative" was belt-and-braces on top of a structural guarantee, and it
 * cost the product the thing it exists to do. What replaces it is not "be bold"
 * — it is a reminder that the tiers are what make thinking out loud *safe*.
 *
 * ## What did not work, recorded so it is not tried again
 *
 * This file carried the sentence *"You are not a question-asking machine"* **at
 * the top and again at the bottom** of `QUESTIONS_INSTRUCTIONS`. Two copies, and
 * the questions stayed interrogatory. Repetition is not leverage: a model is
 * reading the whole prompt, and the rest of it said "be conservative". One copy
 * survives below, because the sentence is fine — it was the surrounding
 * incentives that were wrong.
 *
 * ## Structure
 *
 * Each operation is a stable body plus an appended briefing. **Appended, never
 * prepended**: `adapters/ai/vercel.ts` sends these as the system prompt and notes
 * they are stable per operation "so providers that cache on a system prefix can
 * do so". A per-session block at the front would silently void that for every
 * session, and `prompts.test.ts` pins the prefix property.
 */

/** A session's dials, resolved for one turn. */
export interface Dialled {
  readonly temperament: Temperament;
  readonly counts: TemperamentCounts;
}

const DELTA_CONTRACT = `
You return a DELTA — only what changed. Never restate the whole understanding.

A delta is a flat list of \`ops\`. Each op says what it does in its \`op\` field;
none of it is inferred from which fields you filled in.

- \`add\`     — something new. Leave \`id\` empty; ids are assigned for you.
               \`target\` says which list it joins.
- \`revise\`  — change something that exists. Put its exact id in \`id\`.
- \`retire\`  — drop something that was wrong or is no longer relevant.
- \`promote\` — settle an open item. Put ITS id in \`id\`; it becomes a decision.

**Every field is required, and empty means "nothing here".** Leave a field as ""
when it does not apply, or — on a \`revise\` — when you are not changing it. On a
revise, only the fields you actually fill in are touched; everything else keeps
its current value. \`blocking\` is "yes", "no", or "" for unchanged.

Rules that are enforced in code and will reject your output if broken:
- Never invent an id. Referencing an id that does not exist fails the whole turn.
- Every revise and retire needs a short \`reason\`. It becomes the audit trail.
- Every open item names the coverage \`dimension\` it belongs to.
- Cite what you rely on in \`provenance\`, quoting the source verbatim where you can.
`.trim();

/**
 * The two-tier rule, stated for the model in the terms it must act in.
 *
 * Unchanged in mechanism, and the framing at the end is new: the tiers are what
 * make proposing safe, rather than a reason not to propose. That sentence is
 * load-bearing, because it is what lets the creativity dial mean anything at all
 * without reintroducing the risk the old conservatism was guarding against.
 */
const TIERS = `
There are two tiers, and moving items from the second to the first is your job.

SETTLED — \`target: "decision"\`. Something you are confident is now closed. A
decision carries a \`rationale\`: why this, and not the alternatives.

UNSETTLED — \`target: "requirement" | "constraint" | "assumption" | "contradiction"\`.
Raw needs and open questions. These are proposals, not commitments.

How things move:
- \`op: "promote"\` takes an existing open item by its id and replaces it with a
  decision. Use it the moment something is genuinely settled — an answer
  confirmed it, or a source states it unambiguously.
- \`op: "add"\` with \`target: "decision"\` creates a decision with no open item
  behind it, for something a source settles outright.
- Every decision names what settled it, and there are exactly two ways to say so:
  - **an answer settled it** -> \`op: "promote"\`, with the open item's id in
    \`id\`. The system fills in which answer. When an answer resolves something
    you have not written down yet, promote the open item it most closely
    resolves — that is the right move, not a workaround.
  - **a source settled it** -> \`op: "add"\` with that source's id in
    \`settledBySourceId\`.
  Settle generously when the input actually settles something: a source that
  states a thing plainly *is* a decision, and leaving it as an open requirement
  makes the user answer a question they already answered.
- To replace a decision that turned out wrong, add a NEW decision with
  \`supersedes\` naming the old one. Decisions are never revised and never retired.
- \`retire\` an open item only when it was wrong or no longer relevant. Retiring
  is not settling.

**Putting something in the right tier is what makes it safe to think out loud
here.** An open item gets a question; an assumption carries a \`basis\` the user
can check and a \`risk\` they can weigh. Neither can be mistaken downstream for
something they told you. A decision can be, which is why the bar for that one is
different: do not promote to look productive. A decision nobody actually made is
worse than an open item, because the open item still gets a question and the
decision gets built.
`.trim();

export const ANALYZE_BODY = `
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
- Every assumption carries a \`basis\` — exactly what you filled the hole from —
  and a \`risk\`. How freely to reach for one is set by the dials below.
`.trim();

export const ASSESS_BODY = `
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

Your scores do NOT decide whether gathering is finished — that is counted from
the document itself. What they do is order the next questions, so score for
usefulness: a dimension that holds one shallow decision should score low even
though something is settled there, because that is exactly the case counting
cannot see.

List the IDs of open items that must be settled before this could be specified at
all. Only list ids that appear in the input.
`.trim();

export const QUESTIONS_BODY = `
You write the questions that will close the most uncertainty in the fewest asks.

Every question should read like it came from someone who has already thought the
problem through and is checking their reasoning — not from a form that needs
filling in.

**Assume the user does not already know the answer.** Most people arrive with a
direction rather than a specification, and a question that only a person who had
already decided could answer is a question that will be skipped or guessed at.
Where you have a view, put it on the table and let them react to it; reacting is
far easier than recalling.

Every question names the coverage \`dimension\` it serves. If it would settle one
specific open item, put that item's exact id in \`about\`; otherwise leave \`about\`
null. A question about something nobody has mentioned at all is often the most
valuable one you can ask, and it needs no item to point at.

Every question carries a \`rationale\`: one sentence on why you are asking, in
terms of what it unblocks. "Needed for the spec" is not a rationale.

Give each question 2 or more answer options when plausible answers exist, ordered
most-likely first. Options are the low-effort path: a user should usually be able
to click rather than write. Give a question zero options only when the space of
answers is genuinely open. Never give exactly one option — that is a leading
question, and it is rejected in code.

Every option carries \`means\`: one plain sentence saying what that option
actually is — what it would mean in practice, when it would be the right pick, or
what it would cost. Whichever of those a reader needs most. "Magic links" is a
label; "a sign-in link is emailed each time, so there is no password to store,
but every sign-in needs a working inbox" is an explanation. Write it for someone
who does not already know the answer, because that is who is reading it. This is
the work: you are taking the thinking off the user, not the choosing.

If an option would settle specific open items, list their ids in \`settles\`. Only
list ids that appear in the input, and only ones that option genuinely closes.

You may \`recommend\` one option by its position in your list (0 for the first).
**If you set \`recommends\` you must also set \`because\`** — a recommendation the
user cannot evaluate is an instruction. Set neither, or set both. Recommend only
when you actually have a view; leaving it null is a real answer and a better one
than a coin-flip dressed as advice. The user sees your reasoning, not a pre-ticked
box, and choosing against you costs them nothing.

Set mode to "single" when the answers are mutually exclusive, "multiple" when
several can hold at once. A custom written answer is always accepted regardless;
you do not need to add an "other" option.

Order your questions most important first — only the first few will be asked.

Ask about what you need to build the thing, not about what would be interesting
to know. Question volume is a cost paid by the user.
`.trim();

/**
 * Which dials each operation is told about.
 *
 * Scoped rather than sent wholesale: `analyze` has no questions to ask, so
 * `curiosity` would be noise, and noise in a prompt is not merely wasted tokens —
 * it dilutes the instructions that matter. `assess` gets only `thoroughness`,
 * because its rationales are read by the loop and by `status`, not by the user.
 */
const DIALS_FOR = {
  analyze: ['creativity', 'assertiveness', 'technicality'],
  assess: ['thoroughness'],
  questions: ['creativity', 'assertiveness', 'technicality', 'curiosity'],
} as const satisfies Record<string, readonly DialName[]>;

const withDials = (body: string, dials: readonly DialName[], d: Dialled): string =>
  `${body}\n\n${temperamentBriefing(d.temperament, dials, d.counts)}`;

export const analyzeInstructions = (d: Dialled): string =>
  withDials(ANALYZE_BODY, DIALS_FOR.analyze, d);

export const assessInstructions = (d: Dialled): string =>
  withDials(ASSESS_BODY, DIALS_FOR.assess, d);

export const questionsInstructions = (d: Dialled): string =>
  withDials(QUESTIONS_BODY, DIALS_FOR.questions, d);

/** The merged operation is both bodies, then one briefing covering both dial sets. */
export const analyzeAndAssessInstructions = (d: Dialled): string =>
  withDials(
    `${ANALYZE_BODY}\n\n---\n\n${ASSESS_BODY}\n\nAssess the understanding as it will be AFTER your delta is applied.`,
    [...new Set([...DIALS_FOR.analyze, ...DIALS_FOR.assess])],
    d,
  );
