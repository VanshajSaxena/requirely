import type { z } from 'zod';
import { DecisionId, OpenItemId, SourceId } from '../shared/ids.ts';
import { Assumption, Constraint, Contradiction, Decision, Requirement } from './understanding.ts';

/**
 * Drafts are the only shapes a model may emit.
 *
 * They are the entity schemas minus `id`. A model is good at proposing a
 * requirement and bad at minting a stable identifier, so identity is assigned by
 * the domain. Deriving these with `.omit()` rather than hand-writing them means
 * the draft and the entity cannot drift apart.
 */

export const RequirementDraft = Requirement.omit({ id: true });
export type RequirementDraft = z.infer<typeof RequirementDraft>;

export const ConstraintDraft = Constraint.omit({ id: true });
export type ConstraintDraft = z.infer<typeof ConstraintDraft>;

export const AssumptionDraft = Assumption.omit({ id: true });
export type AssumptionDraft = z.infer<typeof AssumptionDraft>;

export const ContradictionDraft = Contradiction.omit({ id: true });
export type ContradictionDraft = z.infer<typeof ContradictionDraft>;

/**
 * A proposed Decision — everything except its lineage, which the domain owns.
 *
 * Three fields are omitted rather than left to the model, and each omission is
 * load-bearing:
 *
 * - **`id`** — the usual drafts rule.
 * - **`supersededBy`** — it is written on the *other* record. A model saying
 *   "this replaces dec-3" is stating intent; turning that into a forward pointer
 *   on `dec-3` is bookkeeping, and bookkeeping the domain can do correctly is
 *   bookkeeping a model should never be asked to do.
 * - **`settledBy`** — the domain field is `AnswerId | SourceId`, but an `AnswerId`
 *   is a 40-character UUIDv7. Phase 3b deleted `resolvedByAnswerId` for exactly
 *   that reason, so the wire slot here accepts a short `src-N` alone and the
 *   engine derives the answer half from `Question.about`.
 */
export const DecisionDraft = Decision.omit({
  id: true,
  promotedFrom: true,
  settledBy: true,
  supersededBy: true,
}).extend({
  /**
   * A source that states this outright. Null when an answer settles it — leave it
   * null on a `promote` whose open item was the subject of an answered question.
   */
  settledBySourceId: SourceId.nullable().default(null),
  /** The decision this replaces. The domain writes `supersededBy` on that record. */
  supersedes: DecisionId.nullable().default(null),
});
export type DecisionDraft = z.infer<typeof DecisionDraft>;

/**
 * A Decision that closes an open item, which is removed in the same operation.
 *
 * Promotion is a distinct op rather than a `promotedFrom` field on `add`, so
 * intent is stated explicitly instead of inferred from field presence — the
 * pattern mem0, Graphiti and Letta all converged on independently.
 */
export const PromotionDraft = DecisionDraft.extend({
  /** The open item being settled. Must already exist; a model cannot promote what it just added. */
  from: OpenItemId,
});
export type PromotionDraft = z.infer<typeof PromotionDraft>;
