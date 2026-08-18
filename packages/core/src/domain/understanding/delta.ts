import { z } from 'zod';
import {
  AnswerId,
  AssumptionId,
  ConstraintId,
  ContradictionId,
  GapId,
  RequirementId,
} from '../shared/ids.ts';
import {
  AssumptionDraft,
  ConstraintDraft,
  ContradictionDraft,
  GapDraft,
  RequirementDraft,
} from './drafts.ts';
import { ProductSummary } from './understanding.ts';

/**
 * What changed this turn — not the whole understanding rewritten.
 *
 * Regenerating the full document each turn loses requirement identity (so
 * nothing can be diffed and provenance cannot be traced), lets earlier details
 * silently drift as context grows, and costs tokens proportional to total size
 * on every iteration. A delta keeps IDs stable, makes each turn's effect
 * inspectable, and keeps per-turn cost flat.
 *
 * Every mutation carries a `reason`. That is what turns the revision history
 * into an explanation rather than a log.
 */

const removal = <T extends z.ZodType>(id: T) => z.object({ id, reason: z.string().min(1) });

type PatchShape<T extends z.ZodRawShape> = {
  [K in keyof T]: z.ZodOptional<T[K] extends z.ZodDefault<infer Inner> ? Inner : T[K]>;
};

/**
 * Builds a revision schema: every field optional, **with its default stripped**.
 *
 * `.partial()` alone is wrong here and wrong silently. It makes fields optional
 * but leaves their `.default()` intact, so parsing `{ id, reason }` fills in
 * `provenance: []` and `rationale: null` — which then overwrite the real values
 * during the merge. A revision that names one field would quietly erase the
 * rest. Stripping the default first makes an unmentioned field genuinely absent.
 */
function patchOf<T extends z.ZodRawShape>(schema: z.ZodObject<T>): z.ZodObject<PatchShape<T>> {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => {
      // Shape entries and `.unwrap()` are both typed as Zod's core `$ZodType`,
      // which carries no builder methods; the runtime values are full ZodTypes.
      const bare = (field instanceof z.ZodDefault ? field.unwrap() : field) as z.ZodType;
      return [key, bare.optional()];
    }),
    // The runtime construction is correct but not provable to the compiler:
    // erasing each field's default is exactly what PatchShape<T> describes.
  ) as unknown as PatchShape<T>;
  return z.object(shape);
}

export const RequirementRevision = patchOf(RequirementDraft).extend({
  id: RequirementId,
  reason: z.string().min(1),
});
export const ConstraintRevision = patchOf(ConstraintDraft).extend({
  id: ConstraintId,
  reason: z.string().min(1),
});
export const AssumptionRevision = patchOf(AssumptionDraft).extend({
  id: AssumptionId,
  reason: z.string().min(1),
});
export const ContradictionRevision = patchOf(ContradictionDraft).extend({
  id: ContradictionId,
  reason: z.string().min(1),
});
export const GapRevision = patchOf(GapDraft).extend({
  id: GapId,
  reason: z.string().min(1),
});

/** Closing a gap is distinct from deleting one: it records what was learned. */
export const GapResolution = z.object({
  id: GapId,
  resolvedByAnswerId: AnswerId.nullable().default(null),
  resolution: z.string().min(1),
});
export type GapResolution = z.infer<typeof GapResolution>;

export const UnderstandingDelta = z.object({
  /** Partial patch; omitted keys leave the existing value untouched. */
  product: patchOf(ProductSummary).nullable().default(null),

  requirements: z
    .object({
      add: z.array(RequirementDraft).default([]),
      revise: z.array(RequirementRevision).default([]),
      remove: z.array(removal(RequirementId)).default([]),
    })
    .prefault({}),

  constraints: z
    .object({
      add: z.array(ConstraintDraft).default([]),
      revise: z.array(ConstraintRevision).default([]),
      remove: z.array(removal(ConstraintId)).default([]),
    })
    .prefault({}),

  assumptions: z
    .object({
      add: z.array(AssumptionDraft).default([]),
      revise: z.array(AssumptionRevision).default([]),
      remove: z.array(removal(AssumptionId)).default([]),
    })
    .prefault({}),

  contradictions: z
    .object({
      add: z.array(ContradictionDraft).default([]),
      revise: z.array(ContradictionRevision).default([]),
      remove: z.array(removal(ContradictionId)).default([]),
    })
    .prefault({}),

  gaps: z
    .object({
      add: z.array(GapDraft).default([]),
      revise: z.array(GapRevision).default([]),
      remove: z.array(removal(GapId)).default([]),
      resolve: z.array(GapResolution).default([]),
    })
    .prefault({}),
});
export type UnderstandingDelta = z.infer<typeof UnderstandingDelta>;

export function emptyDelta(): UnderstandingDelta {
  return UnderstandingDelta.parse({});
}
