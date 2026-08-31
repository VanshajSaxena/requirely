import { z } from 'zod';
import {
  AssumptionId,
  ConstraintId,
  ContradictionId,
  DecisionId,
  OpenItemId,
  RequirementId,
  RevisionId,
  SessionId,
  SettledBy,
  TurnId,
} from '../shared/ids.ts';
import { Provenance } from '../shared/provenance.ts';
import { Timestamp } from '../shared/time.ts';
import { CoverageDimension } from '../sufficiency/coverage.ts';

export const RequirementKind = z.enum([
  'functional',
  'non-functional',
  'behavioural',
  'acceptance',
]);
export type RequirementKind = z.infer<typeof RequirementKind>;

export const Priority = z.enum(['must', 'should', 'could', 'wont']);
export type Priority = z.infer<typeof Priority>;

export const RiskLevel = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const ConstraintCategory = z.enum([
  'technical',
  'business',
  'operational',
  'regulatory',
  'product',
]);
export type ConstraintCategory = z.infer<typeof ConstraintCategory>;

/**
 * The two fields every uncertain item carries.
 *
 * `dimension` is a **lens, not a verdict** — it says which part of the coverage
 * picture this item belongs to, so "acceptance is the weakest area" resolves to
 * named items rather than to model prose. It used to live on `Gap` alone, which
 * is why deleting `Gap` required moving it rather than dropping it.
 *
 * `blocking` defaults to false because it vetoes sufficiency outright: an
 * opt-out default would let a careless turn deadlock the session.
 */
const openItemFields = {
  dimension: CoverageDimension,
  blocking: z.boolean().default(false),
};

export const Requirement = z.object({
  id: RequirementId,
  statement: z.string().min(1),
  kind: RequirementKind,
  priority: Priority.nullable().default(null),
  rationale: z.string().min(1).nullable().default(null),
  provenance: z.array(Provenance).default([]),
  ...openItemFields,
});
export type Requirement = z.infer<typeof Requirement>;

export const Constraint = z.object({
  id: ConstraintId,
  statement: z.string().min(1),
  category: ConstraintCategory,
  provenance: z.array(Provenance).default([]),
  ...openItemFields,
});
export type Constraint = z.infer<typeof Constraint>;

/**
 * Assumptions are what the system filled in without being told. They are
 * first-class because a finalized-but-exhausted session must be able to state
 * exactly what it guessed at — and because ISO/IEC/IEEE 29148 treats assumptions,
 * constraints and requirements as distinct information items in an SRS.
 *
 * They are also the easiest thing for a model to over-produce. The control is
 * prompting (`engine/prompts.ts` names an assumption a last resort) and the
 * instrument is the eval suite's assumption-per-turn rate — not a schema rule,
 * because "is this assumption warranted?" is not structurally checkable.
 */
export const Assumption = z.object({
  id: AssumptionId,
  statement: z.string().min(1),
  basis: z.string().min(1),
  risk: RiskLevel,
  provenance: z.array(Provenance).default([]),
  ...openItemFields,
});
export type Assumption = z.infer<typeof Assumption>;

/**
 * No `resolution` field, deliberately. Resolving a contradiction *is* deciding
 * which side holds, which is a promotion to a `Decision`. A `resolution` string
 * alongside would be a second way to record the same event, and the one that is
 * not auditable — a Decision names what settled it, a string does not.
 */
export const Contradiction = z.object({
  id: ContradictionId,
  description: z.string().min(1),
  /** At least two citations — a contradiction between fewer sources is a claim. */
  between: z.array(Provenance).min(2),
  ...openItemFields,
});
export type Contradiction = z.infer<typeof Contradiction>;

/** Every kind a `Decision` can take — a superset of `RequirementKind`, so promotion is lossless. */
export const DecisionKind = z.enum([
  'functional',
  'non-functional',
  'behavioural',
  'acceptance',
  'constraint',
  'scope',
]);
export type DecisionKind = z.infer<typeof DecisionKind>;

/**
 * The settled tier. A Decision is something the system believes is now closed.
 *
 * **Decisions are immutable in the ADR sense.** A decision is never edited to
 * flip its content: a new Decision is written and the old one is marked
 * `supersededBy`. That trail is the architectural history, and it is why
 * `decisions[]` grows monotonically and is never pruned.
 *
 * There is deliberately **no `status` enum**. Nygard's vocabulary is
 * Proposed / Accepted / Deprecated / Superseded, but here proposed-vs-accepted
 * *is* the open-item-vs-Decision split, and superseded is derivable from
 * `supersededBy !== null`. One durable reference replaces a tag.
 *
 * `supersededBy` points **forward**, set on the old record, because that makes
 * "is this still current?" a field read rather than a scan of every other
 * decision.
 *
 * Rejected alternatives are **not copied here.** MADR's "Considered Options" is
 * reachable as `settledBy → Answer → Question → options`, so duplicating them
 * would denormalise what a durable reference already reaches.
 */
export const Decision = z.object({
  id: DecisionId,
  statement: z.string().min(1),
  kind: DecisionKind,
  dimension: CoverageDimension,
  /** Why this, over the alternatives. The half of an ADR that a bare statement loses. */
  rationale: z.string().min(1),
  /** The open item this replaced, or null when a source settled it outright. */
  promotedFrom: OpenItemId.nullable().default(null),
  settledBy: SettledBy,
  supersededBy: DecisionId.nullable().default(null),
  provenance: z.array(Provenance).default([]),
});
export type Decision = z.infer<typeof Decision>;

/** Anything still uncertain. The four collections that a Decision can be promoted from. */
export type OpenItem = Requirement | Constraint | Assumption | Contradiction;

export const UserGroup = z.object({
  label: z.string().min(1),
  description: z.string().min(1).nullable().default(null),
  needs: z.array(z.string().min(1)).default([]),
});
export type UserGroup = z.infer<typeof UserGroup>;

export const ProductSummary = z.object({
  name: z.string().min(1).nullable().default(null),
  oneLiner: z.string().min(1).nullable().default(null),
  problem: z.string().min(1).nullable().default(null),
  purpose: z.string().min(1).nullable().default(null),
  users: z.array(UserGroup).default([]),
});
export type ProductSummary = z.infer<typeof ProductSummary>;

/**
 * Monotonic per-collection counters, from which `applyDelta` mints ids.
 *
 * These collections have no table — they live inside one JSONB document — so
 * their ids only need to be unique *within* that document. That is what lets
 * them be short (`req-1`), which is what a model can reliably copy back into a
 * delta. A 40-character UUID shared a 28-character prefix with its neighbours
 * and made every reference a transcription task.
 *
 * A counter rather than `max + 1`: removal makes `max` non-monotonic, so
 * reissuing `req-3` would silently repoint a `Question` from an earlier turn
 * that still stores `about: 'req-3'`. Promotion makes this sharper, not weaker —
 * a promoted item leaves its collection, so `max + 1` would reissue its id to
 * something with unrelated meaning while `Decision.promotedFrom` still names it.
 */
export const NextIds = z.object({
  decision: z.number().int().positive().default(1),
  requirement: z.number().int().positive().default(1),
  constraint: z.number().int().positive().default(1),
  assumption: z.number().int().positive().default(1),
  contradiction: z.number().int().positive().default(1),
});
export type NextIds = z.infer<typeof NextIds>;

/**
 * The durable artifact. Output formats are projections over this, never state of their own.
 *
 * Two tiers, and the ratio between them is the point: `decisions` is what is
 * settled, the other four are what is not. The loop's job is to move items from
 * the second tier to the first. There is no separate `gaps` collection — an
 * unsettled requirement *is* the gap, and a dimension with no decisions and a low
 * coverage score is an absence that needs no entity to represent it.
 *
 * Note `.prefault({})` rather than `.default({})` on `product` and `nextIds`:
 * Zod's `.default()` returns its argument verbatim without parsing it, so
 * `.default({})` would yield a bare `{}` and skip every inner field default.
 * `.prefault()` feeds the value through the schema.
 */
export const Understanding = z.object({
  product: ProductSummary.prefault({}),
  decisions: z.array(Decision).default([]),
  requirements: z.array(Requirement).default([]),
  constraints: z.array(Constraint).default([]),
  assumptions: z.array(Assumption).default([]),
  contradictions: z.array(Contradiction).default([]),
  nextIds: NextIds.prefault({}),
});
export type Understanding = z.infer<typeof Understanding>;

export function emptyUnderstanding(): Understanding {
  return Understanding.parse({});
}

/** Every open item across the four collections, for code that treats the tier uniformly. */
export function openItems(understanding: Understanding): OpenItem[] {
  return [
    ...understanding.requirements,
    ...understanding.constraints,
    ...understanding.assumptions,
    ...understanding.contradictions,
  ];
}

/** Decisions that have not been replaced — the current state, as opposed to the history. */
export function currentDecisions(understanding: Understanding): Decision[] {
  return understanding.decisions.filter((decision) => decision.supersededBy === null);
}

/** One immutable snapshot. Revisions accumulate; they are never edited in place. */
export const UnderstandingRevision = z.object({
  id: RevisionId,
  sessionId: SessionId,
  revision: z.number().int().nonnegative(),
  producedByTurnId: TurnId.nullable().default(null),
  content: Understanding,
  createdAt: Timestamp,
});
export type UnderstandingRevision = z.infer<typeof UnderstandingRevision>;
