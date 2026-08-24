import { DuplicateIdError, UnknownReferenceError } from '../shared/errors.ts';
import {
  type AnswerId,
  AssumptionId,
  ConstraintId,
  ContradictionId,
  GapId,
  ID_PREFIX,
  RequirementId,
} from '../shared/ids.ts';
import type { UnderstandingDelta } from './delta.ts';
import { type Gap, type NextIds, type ResolvedGap, Understanding } from './understanding.ts';

export interface ApplyDeltaContext {
  /**
   * Which answer closed which gap, keyed by gap id.
   *
   * The engine supplies this rather than the model, because it is derivable:
   * a `Question` carries its `gapId` and an `Answer` carries its `questionId`,
   * so gap → answer is a lookup. Asking a model to transcribe a 40-character
   * `AnswerId` to state something already known is pure risk for no information.
   */
  readonly resolvedBy?: ReadonlyMap<string, AnswerId> | undefined;
}

/**
 * `.partial()` schemas can carry explicitly-undefined keys. Spreading those over
 * an existing entity would erase real values, so undefined keys are dropped:
 * "not mentioned in the revision" must mean "unchanged", never "cleared".
 * Clearing a field is done by sending an explicit `null`.
 */
function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * `Partial<T>` under `exactOptionalPropertyTypes` means "key may be absent" but
 * forbids an explicit `undefined`, whereas Zod's `.partial()` produces exactly
 * `T | undefined`. This mapped type admits both — and the fact that `undefined`
 * is representable here is why `stripUndefined` above is load-bearing.
 */
type Patch<E> = { [K in keyof E]?: E[K] | undefined };

interface CollectionOps<E extends { readonly id: string }> {
  readonly add: readonly Omit<E, 'id'>[];
  readonly revise: readonly (Patch<Omit<E, 'id'>> & {
    readonly id: string;
    readonly reason: string;
  })[];
  readonly remove: readonly { readonly id: string }[];
}

/**
 * Applies add / revise / remove to one collection.
 *
 * Unknown IDs throw rather than being ignored. A model that invents `req-99`
 * must fail loudly — silently discarding the operation would mean the delta was
 * only partly applied while the turn still reported success, and the divergence
 * would surface many turns later as an inexplicable missing requirement.
 */
function mergeCollection<E extends { readonly id: string }>(
  collection: string,
  current: readonly E[],
  ops: CollectionOps<E>,
  mintId: () => E['id'],
): E[] {
  const byId = new Map<string, E>(current.map((entry) => [entry.id, entry]));

  const unknown = [...ops.revise, ...ops.remove].map((op) => op.id).filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new UnknownReferenceError(collection, [...new Set(unknown)]);
  }

  for (const entry of ops.revise) {
    const { id, reason: _reason, ...patch } = entry;
    const existing = byId.get(id);
    if (existing !== undefined) {
      // Safe: `patch` is a partial of E minus `id`, spread over a complete E.
      byId.set(id, { ...existing, ...stripUndefined(patch) } as E);
    }
  }

  for (const entry of ops.remove) byId.delete(entry.id);

  // Insertion order is preserved, so newly added entries land at the end and the
  // sequence stays stable across turns — which is what makes diffs readable.
  const taken = new Set(byId.keys());
  const added: E[] = [];

  for (const draft of ops.add) {
    const id = mintId();
    // The counter makes this unreachable in normal operation. It stays as a
    // guard against a document whose counter disagrees with its contents —
    // hand-edited JSONB, a bad migration — because two entries sharing an id
    // makes every later `revise` ambiguous and silently picks whichever one
    // the map happened to keep.
    if (taken.has(id)) {
      throw new DuplicateIdError(collection, id);
    }
    taken.add(id);
    added.push({ ...draft, id } as E);
  }

  return [...byId.values(), ...added];
}

/**
 * Produces the next Understanding from the current one plus a delta.
 *
 * Pure and total: it is now a function of `(current, delta)` alone — no
 * `IdGenerator`, because ids are minted from counters carried in the document
 * itself. That makes it *more* deterministic than before, not less.
 *
 * Either the whole delta applies or it throws. There is no partial path.
 */
export function applyDelta(
  current: Understanding,
  delta: UnderstandingDelta,
  ctx: ApplyDeltaContext = {},
): Understanding {
  // Mutated as ids are handed out, then written back as the next document's
  // counters. Local to this call, so purity is preserved.
  const counters: NextIds = { ...current.nextIds };

  const mint =
    <T>(kind: keyof NextIds, brand: { parse: (v: unknown) => T }) =>
    (): T => {
      const ordinal = counters[kind];
      counters[kind] = ordinal + 1;
      return brand.parse(`${ID_PREFIX[kind]}-${ordinal}`);
    };

  const requirements = mergeCollection(
    'requirement',
    current.requirements,
    delta.requirements,
    mint('requirement', RequirementId),
  );
  const constraints = mergeCollection(
    'constraint',
    current.constraints,
    delta.constraints,
    mint('constraint', ConstraintId),
  );
  const assumptions = mergeCollection(
    'assumption',
    current.assumptions,
    delta.assumptions,
    mint('assumption', AssumptionId),
  );
  const contradictions = mergeCollection(
    'contradiction',
    current.contradictions,
    delta.contradictions,
    mint('contradiction', ContradictionId),
  );

  const mergedGaps = mergeCollection('gap', current.gaps, delta.gaps, mint('gap', GapId));

  // Resolution runs after add/revise/remove so it sees the merged set. It can
  // only target gaps that already existed, since a gap added in this same delta
  // has a freshly minted ID the model had no way to reference.
  const openGaps = new Map<string, Gap>(mergedGaps.map((gap) => [gap.id, gap]));
  const unknownResolutions = delta.gaps.resolve
    .map((resolution) => resolution.id)
    .filter((id) => !openGaps.has(id));
  if (unknownResolutions.length > 0) {
    throw new UnknownReferenceError('gap (resolution)', [...new Set(unknownResolutions)]);
  }

  const newlyResolved: ResolvedGap[] = [];
  for (const resolution of delta.gaps.resolve) {
    const gap = openGaps.get(resolution.id);
    if (gap === undefined) continue;
    openGaps.delete(resolution.id);
    newlyResolved.push({
      ...gap,
      resolvedByAnswerId: ctx.resolvedBy?.get(resolution.id) ?? null,
      resolution: resolution.resolution,
    });
  }

  const product =
    delta.product === null
      ? current.product
      : { ...current.product, ...stripUndefined(delta.product) };

  // Re-parsing guarantees applyDelta can never emit an invalid Understanding,
  // regardless of what a model proposed.
  return Understanding.parse({
    product,
    requirements,
    constraints,
    assumptions,
    contradictions,
    gaps: [...openGaps.values()],
    resolvedGaps: [...current.resolvedGaps, ...newlyResolved],
    nextIds: counters,
  });
}
