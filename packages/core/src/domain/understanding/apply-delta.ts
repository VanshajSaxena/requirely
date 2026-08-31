import {
  DuplicateIdError,
  UnknownReferenceError,
  UnsettledDecisionError,
} from '../shared/errors.ts';
import {
  type AnswerId,
  AssumptionId,
  ConstraintId,
  ContradictionId,
  DecisionId,
  ID_PREFIX,
  type OpenItemId,
  RequirementId,
  type SettledBy,
  type SourceId,
} from '../shared/ids.ts';
import type { UnderstandingDelta } from './delta.ts';
import type { DecisionDraft, PromotionDraft } from './drafts.ts';
import { type Decision, type NextIds, type OpenItem, Understanding } from './understanding.ts';

export interface ApplyDeltaContext {
  /**
   * Which answer settled which open item, keyed by open-item id.
   *
   * The engine supplies this rather than the model, because it is derivable: a
   * `Question` carries `about` and an `Answer` carries its `questionId`, so
   * item → answer is a lookup. Asking a model to transcribe a 40-character
   * `AnswerId` to state something already known is pure risk for no information.
   *
   * When a promotion's `from` appears here, the derived answer **wins** over
   * whatever source the model cited: the engine's fact beats the model's claim.
   */
  readonly settledBy?: ReadonlyMap<string, AnswerId> | undefined;
  /**
   * Every source id this session actually has, for validating a model-cited
   * `settledBySourceId`.
   *
   * Optional, and skipped when absent — deliberately, because most unit tests
   * construct a delta with no session behind it. The engine always supplies it,
   * so the production path is always checked; a test that wants the check writes
   * the set.
   */
  readonly knownSourceIds?: ReadonlySet<string> | undefined;
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
  readonly retire: readonly { readonly id: string }[];
}

/**
 * Applies add / revise / retire to one uncertain collection.
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

  const unknown = [...ops.revise, ...ops.retire].map((op) => op.id).filter((id) => !byId.has(id));
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

  for (const entry of ops.retire) byId.delete(entry.id);

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
 * Pure and total: a function of `(current, delta)` plus an optional context of
 * facts the *engine* knows and the model does not. No `IdGenerator` — ids are
 * minted from counters carried in the document itself.
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

  // Keyed by id across all four collections at once. Promotion is the one
  // operation that does not care which collection an item came from — that is
  // what makes them one tier rather than four unrelated lists.
  const open = new Map<string, { item: OpenItem; collection: OpenItem[] }>();
  for (const collection of [requirements, constraints, assumptions, contradictions]) {
    for (const item of collection) open.set(item.id, { item, collection });
  }

  const mintDecision = mint('decision', DecisionId);
  const decisions = [...current.decisions];
  const byDecisionId = new Map<string, number>(decisions.map((d, index) => [d.id, index]));

  /**
   * Resolves what settled a decision, preferring the engine's derived answer over
   * the model's cited source. Throws rather than defaulting: a Decision with no
   * traceable origin is exactly the un-auditable record this tier exists to avoid.
   */
  const settledByFor = (draft: DecisionDraft, from: OpenItemId | null): SettledBy => {
    const derived = from === null ? undefined : ctx.settledBy?.get(from);
    if (derived !== undefined) return derived;

    const cited = draft.settledBySourceId;
    if (cited === null) throw new UnsettledDecisionError(draft.statement, from);
    if (ctx.knownSourceIds !== undefined && !ctx.knownSourceIds.has(cited)) {
      throw new UnknownReferenceError('decision (settledBySourceId)', [cited]);
    }
    return cited as SourceId;
  };

  /**
   * Writes the forward pointer onto the record being replaced.
   *
   * Superseding an already-superseded decision throws: it means the model was
   * reasoning about state two revisions stale, and silently allowing it would
   * fork the supersession chain into a shape nothing can render.
   */
  const applySupersession = (target: DecisionId | null, replacement: DecisionId): void => {
    if (target === null) return;
    const index = byDecisionId.get(target);
    const existing = index === undefined ? undefined : decisions[index];
    if (index === undefined || existing === undefined) {
      throw new UnknownReferenceError('decision (supersedes)', [target]);
    }
    if (existing.supersededBy !== null) {
      throw new UnknownReferenceError('decision (already superseded)', [target]);
    }
    decisions[index] = { ...existing, supersededBy: replacement };
  };

  const decisionFrom = (draft: DecisionDraft, from: OpenItemId | null): Decision => {
    const { settledBySourceId: _cited, supersedes: _supersedes, ...content } = draft;
    const id = mintDecision();
    const decision: Decision = {
      ...content,
      id,
      promotedFrom: from,
      settledBy: settledByFor(draft, from),
      supersededBy: null,
    };
    applySupersession(draft.supersedes, id);
    decisions.push(decision);
    byDecisionId.set(id, decisions.length - 1);
    return decision;
  };

  // Promotions are validated as a batch before any of them runs, so a delta with
  // one bad reference fails with every bad reference named rather than with the
  // first — the same contract `mergeCollection` gives.
  const promotions: readonly PromotionDraft[] = delta.decisions.promote;
  const unknownPromotions = promotions.map((p) => p.from).filter((from) => !open.has(from));
  if (unknownPromotions.length > 0) {
    throw new UnknownReferenceError('open item (promotion)', [...new Set(unknownPromotions)]);
  }
  const seenFrom = new Set<string>();
  const duplicatePromotions: string[] = [];
  for (const { from } of promotions) {
    if (seenFrom.has(from)) duplicatePromotions.push(from);
    seenFrom.add(from);
  }
  if (duplicatePromotions.length > 0) {
    throw new DuplicateIdError(
      'open item (promotion)',
      [...new Set(duplicatePromotions)].join(', '),
    );
  }

  for (const promotion of promotions) {
    const entry = open.get(promotion.from);
    if (entry === undefined) continue;
    decisionFrom(promotion, promotion.from);
    // Removing from the live array rather than rebuilding: `open` holds the very
    // arrays that get parsed below, so this is the removal.
    entry.collection.splice(entry.collection.indexOf(entry.item), 1);
    open.delete(promotion.from);
  }

  for (const draft of delta.decisions.add) decisionFrom(draft, null);

  const product =
    delta.product === null
      ? current.product
      : { ...current.product, ...stripUndefined(delta.product) };

  // Re-parsing guarantees applyDelta can never emit an invalid Understanding,
  // regardless of what a model proposed.
  return Understanding.parse({
    product,
    decisions,
    requirements,
    constraints,
    assumptions,
    contradictions,
    nextIds: counters,
  });
}
