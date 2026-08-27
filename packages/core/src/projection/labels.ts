import type {
  ConstraintCategory,
  CoverageDimension,
  Priority,
  RequirementKind,
  RiskLevel,
} from '../domain/index.ts';

/**
 * Stored ids become document labels: `req-1` → `REQ-1`, `gap-3` → `GAP-3`.
 *
 * This file is where Phase 3b pays off. Ids inside an `Understanding` are
 * document-scoped and sequential precisely because nothing about them needed to
 * be globally unique — and the side effect is that **the stored id already is
 * the citation number** every specification wants. Had ids stayed UUIDv7, this
 * file would need a numbering scheme of its own plus a stable id→number map
 * maintained across revisions, which is a second identifier system to keep
 * honest.
 */
export const label = (id: string): string => id.toUpperCase();

/** Ids sort as `req-2` < `req-10` only if the numeric part is compared. */
export const byOrdinal = (a: { id: string }, b: { id: string }): number => {
  const ordinal = (id: string): number => Number.parseInt(id.split('-').pop() ?? '0', 10);
  return ordinal(a.id) - ordinal(b.id);
};

export const REQUIREMENT_KIND: Record<RequirementKind, string> = {
  functional: 'Functional',
  'non-functional': 'Non-functional',
  behavioural: 'Behavioural',
  acceptance: 'Acceptance',
};

export const CONSTRAINT_CATEGORY: Record<ConstraintCategory, string> = {
  technical: 'Technical',
  business: 'Business',
  operational: 'Operational',
  regulatory: 'Regulatory',
  product: 'Product',
};

export const DIMENSION: Record<CoverageDimension, string> = {
  purpose: 'purpose',
  users: 'users',
  'core-behaviour': 'core behaviour',
  data: 'data',
  constraints: 'constraints',
  'edge-cases': 'edge cases',
  acceptance: 'acceptance',
  integrations: 'integrations',
};

export const RISK: Record<RiskLevel, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

/** MoSCoW. `wont` is stored without an apostrophe; it is not written that way. */
export const PRIORITY: Record<Priority, string> = {
  must: 'Must',
  should: 'Should',
  could: 'Could',
  wont: "Won't",
};
