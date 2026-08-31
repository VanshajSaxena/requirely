import { z } from 'zod';
import { AssumptionId, ConstraintId, ContradictionId, RequirementId } from '../shared/ids.ts';
import {
  AssumptionDraft,
  ConstraintDraft,
  ContradictionDraft,
  DecisionDraft,
  PromotionDraft,
  RequirementDraft,
} from './drafts.ts';
import { ProductSummary } from './understanding.ts';

/**
 * What changed this turn — not the whole understanding rewritten.
 *
 * Regenerating the full document each turn loses item identity (so nothing can be
 * diffed and provenance cannot be traced), lets earlier details silently drift as
 * context grows, and costs tokens proportional to total size on every iteration.
 * A delta keeps IDs stable, makes each turn's effect inspectable, and keeps
 * per-turn cost flat.
 *
 * Every mutation carries a `reason`. That is what turns the revision history
 * into an explanation rather than a log.
 *
 * **This is the domain-facing delta, not the wire format.** The shape a model
 * actually emits is a flat op list in `src/wire/`, decoded into this. Assembling
 * a delta out of domain schemas is what made the emitted JSON Schema 71 optional
 * properties deep and uncompilable as a decoding grammar; keeping the two apart
 * is the whole point of the codec.
 */

const retirement = <T extends z.ZodType>(id: T) => z.object({ id, reason: z.string().min(1) });

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

/**
 * One uncertain collection's operations.
 *
 * `retire`, not `remove`: an item leaves this array for two different reasons —
 * it was wrong, or it was promoted — and only the first is a retirement. Naming
 * them apart is what keeps "we dropped it" distinguishable from "we settled it"
 * in the audit trail.
 */
const openItemOps = <D extends z.ZodType, R extends z.ZodType, I extends z.ZodType>(
  draft: D,
  revision: R,
  id: I,
) =>
  z
    .object({
      add: z.array(draft).default([]),
      revise: z.array(revision).default([]),
      retire: z.array(retirement(id)).default([]),
    })
    .prefault({});

export const UnderstandingDelta = z.object({
  /** Partial patch; omitted keys leave the existing value untouched. */
  product: patchOf(ProductSummary).nullable().default(null),

  /**
   * No `revise` and no `retire`.
   *
   * A Decision is immutable in the ADR sense: it is never edited to flip its
   * content, and it is never deleted. Replacing one means adding another with
   * `supersedes` set, after which `applyDelta` writes the forward pointer. The
   * absence of those two arrays is what makes that unexpressible rather than
   * merely discouraged.
   */
  decisions: z
    .object({
      add: z.array(DecisionDraft).default([]),
      promote: z.array(PromotionDraft).default([]),
    })
    .prefault({}),

  requirements: openItemOps(RequirementDraft, RequirementRevision, RequirementId),
  constraints: openItemOps(ConstraintDraft, ConstraintRevision, ConstraintId),
  assumptions: openItemOps(AssumptionDraft, AssumptionRevision, AssumptionId),
  contradictions: openItemOps(ContradictionDraft, ContradictionRevision, ContradictionId),
});
export type UnderstandingDelta = z.infer<typeof UnderstandingDelta>;

export function emptyDelta(): UnderstandingDelta {
  return UnderstandingDelta.parse({});
}
