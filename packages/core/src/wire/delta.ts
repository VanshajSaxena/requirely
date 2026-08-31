import { z } from 'zod';
import {
  ConstraintCategory,
  CoverageDimension,
  DecisionKind,
  Priority,
  RiskLevel,
} from '../domain/index.ts';
import { ABSENT, optionalEnum, WireFlag } from './sentinel.ts';

/**
 * What a model actually emits, and the codec that turns it into a domain delta.
 *
 * **The domain delta is not sendable and was never meant to be.** It is
 * assembled out of domain schemas, so every `.default()`, `.nullable()` and
 * `.optional()` in the domain becomes a grammar branch: 84 optional properties
 * and 34 unions against provider caps of 24 and 16. Shrinking the domain to fit
 * a vendor's compiler would be letting the wire dictate the model.
 *
 * So there are two shapes and a total function between them. Three rules:
 *
 * 1. **One flat op list, not six nested collections.** Intent is an explicit
 *    `op` field, never field presence. mem0, Graphiti and Letta converged on
 *    this independently; the measurable reason is that six `{add,revise,retire}`
 *    objects are six nested branch points and one array is one.
 * 2. **Every field required; absence is `''` or `[]`.** See `sentinel.ts`.
 * 3. **The codec is where per-kind validation lands.** `WireOp` is deliberately a
 *    loose superset — an assumption's `basis` and a constraint's `category` sit
 *    side by side — and `decode` narrows it, reporting failures at **wire paths**
 *    like `ops[3].kind` so a reask names something the model can actually see.
 */

/**
 * Which collection an `add` lands in.
 *
 * Read for `add` only. For `revise` and `retire` the **id prefix is
 * authoritative** and this field is ignored, deliberately: the two can disagree,
 * one of them has to win, and resolving the disagreement by throwing would cost
 * a whole turn over a redundancy we introduced ourselves. Same asymmetry
 * `resolveBlockingItems` documents. For `promote` the result is always a
 * decision, so neither is consulted.
 */
export const WireTarget = z.enum([
  'decision',
  'requirement',
  'constraint',
  'assumption',
  'contradiction',
]);
export type WireTarget = z.infer<typeof WireTarget>;

export const WireOperation = z.enum(['add', 'revise', 'retire', 'promote']);
export type WireOperation = z.infer<typeof WireOperation>;

/** `sourceId` is `.min(1)`: a citation with no source is not a cheaper citation, it is a lie. */
export const WireProvenance = z.object({
  sourceId: z.string().min(1),
  quote: z.string(),
  note: z.string(),
});
export type WireProvenance = z.infer<typeof WireProvenance>;

export const WireUser = z.object({
  label: z.string().min(1),
  description: z.string(),
  needs: z.array(z.string().min(1)),
});

/**
 * A product patch. `''` means **leave unchanged**, matching `revise` semantics.
 *
 * `users: []` also means unchanged, so clearing every user group is not
 * expressible. That is a real limitation and an unreal operation — nobody
 * removes the entire audience without replacing it.
 */
export const WireProduct = z.object({
  name: z.string(),
  oneLiner: z.string(),
  problem: z.string(),
  purpose: z.string(),
  users: z.array(WireUser),
});
export type WireProduct = z.infer<typeof WireProduct>;

/**
 * One operation. Sixteen always-present fields, most of them usually empty.
 *
 * That verbosity is the trade and it is worth naming: an empty string costs
 * roughly two output tokens, so a ten-op turn spends a few hundred tokens on
 * emptiness. It buys a schema with **zero optional properties**, which is the
 * difference between a request a provider will compile and one it rejects. The
 * eval suite measures the token side so the trade stays checkable.
 *
 * `id` always names the thing the op acts on: `''` for `add`, the item id for
 * `revise` and `retire`, and the open item being settled for `promote`. There is
 * no separate `from` field, because a second way to name the same thing is a
 * second way to get it wrong.
 */
export const WireOp = z.object({
  op: WireOperation,
  target: WireTarget,
  id: z.string(),
  /** Also carries a contradiction's `description` — one field, one meaning: the text. */
  statement: z.string(),
  /** `DecisionKind` is a superset of `RequirementKind`, so one enum serves both. */
  kind: optionalEnum(DecisionKind.options),
  category: optionalEnum(ConstraintCategory.options),
  risk: optionalEnum(RiskLevel.options),
  priority: optionalEnum(Priority.options),
  dimension: optionalEnum(CoverageDimension.options),
  blocking: WireFlag,
  basis: z.string(),
  rationale: z.string(),
  /** A source that settles a decision. Never an answer — see `DecisionDraft`. */
  settledBySourceId: z.string(),
  supersedes: z.string(),
  reason: z.string(),
  provenance: z.array(WireProvenance),
});
export type WireOp = z.infer<typeof WireOp>;

export const WireDelta = z.object({
  product: WireProduct,
  ops: z.array(WireOp),
});
export type WireDelta = z.infer<typeof WireDelta>;

/** An op with every field at its sentinel, so callers state only what they mean. */
export const emptyOp = (): WireOp => ({
  op: 'add',
  target: 'requirement',
  id: ABSENT,
  statement: ABSENT,
  kind: ABSENT,
  category: ABSENT,
  risk: ABSENT,
  priority: ABSENT,
  dimension: ABSENT,
  blocking: ABSENT,
  basis: ABSENT,
  rationale: ABSENT,
  settledBySourceId: ABSENT,
  supersedes: ABSENT,
  reason: ABSENT,
  provenance: [],
});

export const emptyWireDelta = (): WireDelta => ({
  product: { name: ABSENT, oneLiner: ABSENT, problem: ABSENT, purpose: ABSENT, users: [] },
  ops: [],
});

/**
 * One worked example of a delta, for `prompted` generation.
 *
 * Small on purpose: it shows the two operations a model gets wrong most often —
 * an `add` (where `id` is empty and ids are assigned) and a `promote` (where
 * `id` names the item being settled, not the decision being created) — and
 * nothing else. An example that demonstrated all four ops would cost four times
 * the tokens to teach the same grammar.
 *
 * A test parses it against `UnderstandingDeltaCodec`, so an example that drifts
 * from the schema fails CI instead of quietly teaching a model the wrong shape.
 */
export const DELTA_EXAMPLE: WireDelta = {
  product: {
    name: 'Acme Scheduler',
    oneLiner: 'Book rooms without arguing in Slack',
    problem: ABSENT,
    purpose: ABSENT,
    users: [],
  },
  ops: [
    {
      ...emptyOp(),
      op: 'add',
      target: 'requirement',
      statement: 'Users can see which rooms are free right now',
      kind: 'functional',
      dimension: 'core-behaviour',
      blocking: 'no',
      provenance: [{ sourceId: 'src-1', quote: 'I just want to see what is free', note: ABSENT }],
    },
    {
      ...emptyOp(),
      op: 'promote',
      target: 'decision',
      id: 'req-4',
      statement: 'Availability is read from Google Calendar, not entered by hand',
      kind: 'functional',
      dimension: 'integrations',
      rationale: 'Chosen over manual entry, which the team said nobody would keep up to date.',
    },
  ],
};
