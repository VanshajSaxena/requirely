import { z } from 'zod';
import {
  AnswerId,
  AssumptionId,
  ConstraintId,
  ContradictionId,
  GapId,
  RequirementId,
  RevisionId,
  SessionId,
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

export const Requirement = z.object({
  id: RequirementId,
  statement: z.string().min(1),
  kind: RequirementKind,
  priority: Priority.nullable().default(null),
  rationale: z.string().min(1).nullable().default(null),
  provenance: z.array(Provenance).default([]),
});
export type Requirement = z.infer<typeof Requirement>;

export const Constraint = z.object({
  id: ConstraintId,
  statement: z.string().min(1),
  category: ConstraintCategory,
  provenance: z.array(Provenance).default([]),
});
export type Constraint = z.infer<typeof Constraint>;

/**
 * Assumptions are what the system filled in without being told. They are
 * first-class because a finalized-but-exhausted session must be able to state
 * exactly what it guessed at.
 */
export const Assumption = z.object({
  id: AssumptionId,
  statement: z.string().min(1),
  basis: z.string().min(1),
  risk: RiskLevel,
  provenance: z.array(Provenance).default([]),
});
export type Assumption = z.infer<typeof Assumption>;

export const Contradiction = z.object({
  id: ContradictionId,
  description: z.string().min(1),
  /** At least two citations — a contradiction between fewer sources is a claim. */
  between: z.array(Provenance).min(2),
  resolution: z.string().min(1).nullable().default(null),
});
export type Contradiction = z.infer<typeof Contradiction>;

export const Gap = z.object({
  id: GapId,
  dimension: CoverageDimension,
  topic: z.string().min(1),
  description: z.string().min(1),
  /** Blocking gaps veto sufficiency outright, regardless of coverage scores. */
  blocking: z.boolean(),
  impact: RiskLevel,
});
export type Gap = z.infer<typeof Gap>;

/**
 * Closed gaps move here rather than being deleted. This is what lets a generated
 * document show "what we asked and what we learned", and what makes a loop
 * transcript reconstructable after the fact.
 */
export const ResolvedGap = Gap.extend({
  resolvedByAnswerId: AnswerId.nullable().default(null),
  resolution: z.string().min(1),
});
export type ResolvedGap = z.infer<typeof ResolvedGap>;

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
 * The durable artifact. Output formats are projections over this, never state of their own.
 *
 * Note `.prefault({})` rather than `.default({})` on `product`: Zod's `.default()`
 * returns its argument verbatim without parsing it, so `.default({})` would yield
 * a bare `{}` and skip every inner field default. `.prefault()` feeds the value
 * through the schema, producing the fully-populated shape.
 */
export const Understanding = z.object({
  product: ProductSummary.prefault({}),
  requirements: z.array(Requirement).default([]),
  constraints: z.array(Constraint).default([]),
  assumptions: z.array(Assumption).default([]),
  contradictions: z.array(Contradiction).default([]),
  gaps: z.array(Gap).default([]),
  resolvedGaps: z.array(ResolvedGap).default([]),
});
export type Understanding = z.infer<typeof Understanding>;

export function emptyUnderstanding(): Understanding {
  return Understanding.parse({});
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
