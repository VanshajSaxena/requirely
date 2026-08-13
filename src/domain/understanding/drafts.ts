import type { z } from 'zod';
import { Assumption, Constraint, Contradiction, Gap, Requirement } from './understanding.ts';

/**
 * Drafts are the only shapes a model may emit.
 *
 * They are the entity schemas minus `id`. A model is good at proposing a
 * requirement and bad at minting a stable identifier, so identity is assigned by
 * the domain via the IdGenerator port. Deriving these with `.omit()` rather than
 * hand-writing them means the draft and the entity cannot drift apart.
 */

export const RequirementDraft = Requirement.omit({ id: true });
export type RequirementDraft = z.infer<typeof RequirementDraft>;

export const ConstraintDraft = Constraint.omit({ id: true });
export type ConstraintDraft = z.infer<typeof ConstraintDraft>;

export const AssumptionDraft = Assumption.omit({ id: true });
export type AssumptionDraft = z.infer<typeof AssumptionDraft>;

export const ContradictionDraft = Contradiction.omit({ id: true });
export type ContradictionDraft = z.infer<typeof ContradictionDraft>;

export const GapDraft = Gap.omit({ id: true });
export type GapDraft = z.infer<typeof GapDraft>;
