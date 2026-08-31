import { z } from 'zod';
import { OPEN_ITEM_PREFIXES, UnderstandingDelta } from '../domain/index.ts';
import { emptyOp, WireDelta, type WireOp, type WireProvenance, type WireTarget } from './delta.ts';
import { ABSENT, booleanToFlag, flagToBoolean, orAbsent, orNull } from './sentinel.ts';

/**
 * `WireDelta` ⟷ `UnderstandingDelta`.
 *
 * One `z.codec` yields four things that would otherwise be four artifacts kept
 * in sync by hand: the wire JSON Schema (`z.toJSONSchema(codec, {io:'input'})`),
 * the domain type (`io:'output'`), a total `decode`, and an `encode`.
 *
 * **`encode` exists for the test, and that is not a weakness.** A property test
 * asserting `decode(encode(x)) ≡ x` fails the moment the two shapes disagree, so
 * adding a domain field without teaching the wire about it is a CI failure
 * rather than a field that silently never reaches the model. Nothing in
 * production calls it.
 *
 * ## How this reaches a provider
 *
 * Nothing in `adapters/` changed. `@ai-sdk/provider-utils` converts a Zod 4
 * schema with `toJSONSchema(schema, { target: 'draft-7', io: 'input' })` and
 * validates with `safeParseAsync(schema, value)` returning `result.data` — which
 * for a codec means *it emits the wire schema and hands back a decoded domain
 * value*. Verified by reading `dist/index.js` at v5.0.29, not assumed.
 *
 * The SDK also wraps every conversion in `addAdditionalPropertiesToJsonSchema`,
 * which matters: Zod's `io: 'input'` projection **silently omits**
 * `additionalProperties: false`, and strict mode requires it. That patch lives
 * downstream of us, so anything that bypasses the SDK must reimplement it.
 *
 * ## Failures are retryable, not fatal
 *
 * `decode` reports through `ctx.issues` rather than throwing, so a malformed op
 * comes back from `safeParse` as an ordinary `ZodError`. `withValidationRetry`
 * already re-asks on those with the issues appended — so "you promoted an item
 * you never mentioned" costs one more attempt instead of the whole turn.
 */

type Issue = { readonly path: readonly (string | number)[]; readonly message: string };

/** Collects issues at wire paths, so a reask names something the model can see. */
class OpReader {
  readonly issues: Issue[] = [];
  private readonly index: number;
  private readonly op: WireOp;

  constructor(op: WireOp, index: number) {
    this.op = op;
    this.index = index;
  }

  /** A required field: empty is an error reported against the field the model wrote. */
  need(field: keyof WireOp & string): string {
    const value = this.op[field];
    const text = typeof value === 'string' ? value : ABSENT;
    if (text === ABSENT) {
      this.issues.push({
        path: ['ops', this.index, field],
        message: `\`${field}\` is required for op "${this.op.op}" on a ${this.op.target}.`,
      });
    }
    return text;
  }

  fail(field: string, message: string): void {
    this.issues.push({ path: ['ops', this.index, field], message });
  }
}

const provenanceIn = (entries: readonly WireProvenance[]) =>
  entries.map((entry) => ({
    sourceId: entry.sourceId,
    quote: orNull(entry.quote),
    note: orNull(entry.note),
  }));

/**
 * Only present keys reach a `revise`, so an untouched field stays untouched.
 *
 * `''` therefore means "leave alone" here while it means "absent" on an `add`.
 * The two readings never collide because they are selected by `op`, and a model
 * needs no awareness of the distinction: "leave it empty" is the same
 * instruction either way.
 *
 * **The cost, stated:** clearing a nullable field back to `null` through a
 * revise is not expressible on the wire, because `''` is already spoken for.
 * `retire` plus `add` is the escape hatch, and a test pins the limitation so it
 * is discovered here rather than in a session.
 */
const set = <K extends string, T>(key: K, value: T | undefined): Partial<Record<K, T>> =>
  value === undefined ? {} : ({ [key]: value } as Partial<Record<K, T>>);

const text = (value: string): string | undefined => (value === ABSENT ? undefined : value);

/** Which collection an id belongs to. The prefix is the only thing that knows. */
const COLLECTION_OF_PREFIX: Record<string, Exclude<WireTarget, 'decision'>> = {
  req: 'requirement',
  con: 'constraint',
  asm: 'assumption',
  ctr: 'contradiction',
};

const collectionForId = (id: string): Exclude<WireTarget, 'decision'> | undefined =>
  COLLECTION_OF_PREFIX[id.slice(0, 3)];

/** The mutable shape decode builds up, before `UnderstandingDelta` parses it. */
interface DeltaAccumulator {
  product: Record<string, unknown> | null;
  decisions: { add: unknown[]; promote: unknown[] };
  requirements: Ops;
  constraints: Ops;
  assumptions: Ops;
  contradictions: Ops;
}
interface Ops {
  add: unknown[];
  revise: unknown[];
  retire: unknown[];
}

const emptyOps = (): Ops => ({ add: [], revise: [], retire: [] });

const COLLECTION_KEY = {
  requirement: 'requirements',
  constraint: 'constraints',
  assumption: 'assumptions',
  contradiction: 'contradictions',
} as const;

function decodeProduct(product: WireDelta['product']): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {
    ...set('name', text(product.name)),
    ...set('oneLiner', text(product.oneLiner)),
    ...set('problem', text(product.problem)),
    ...set('purpose', text(product.purpose)),
    ...set(
      'users',
      product.users.length === 0
        ? undefined
        : product.users.map((user) => ({
            label: user.label,
            description: orNull(user.description),
            needs: user.needs,
          })),
    ),
  };
  // An all-sentinel product is "no change", which the domain spells `null`.
  // Collapsing it here rather than emitting `{}` is what makes the round-trip
  // property hold exactly instead of only semantically.
  return Object.keys(patch).length === 0 ? null : patch;
}

/** The content fields an `add` or `promote` supplies, narrowed per target. */
function decodeContent(reader: OpReader, op: WireOp, target: WireTarget): Record<string, unknown> {
  const dimension = reader.need('dimension');
  const provenance = provenanceIn(op.provenance);
  const blocking = flagToBoolean(op.blocking) ?? false;

  if (target === 'decision') {
    return {
      statement: reader.need('statement'),
      kind: reader.need('kind'),
      dimension,
      rationale: reader.need('rationale'),
      settledBySourceId: orNull(op.settledBySourceId),
      supersedes: orNull(op.supersedes),
      provenance,
    };
  }
  if (target === 'requirement') {
    return {
      statement: reader.need('statement'),
      kind: reader.need('kind'),
      dimension,
      blocking,
      priority: orNull(op.priority),
      rationale: orNull(op.rationale),
      provenance,
    };
  }
  if (target === 'constraint') {
    return {
      statement: reader.need('statement'),
      category: reader.need('category'),
      dimension,
      blocking,
      provenance,
    };
  }
  if (target === 'assumption') {
    return {
      statement: reader.need('statement'),
      basis: reader.need('basis'),
      risk: reader.need('risk'),
      dimension,
      blocking,
      provenance,
    };
  }
  // contradiction — `provenance` is the domain's `between`, which requires two
  // entries. Checked here so the message names `ops[n].provenance` rather than
  // surfacing as `contradictions.add.0.between` from a schema nobody sent.
  if (op.provenance.length < 2) {
    reader.fail(
      'provenance',
      'A contradiction must cite at least two sources; with fewer it is a claim, not a conflict.',
    );
  }
  return {
    description: reader.need('statement'),
    between: provenance,
    dimension,
    blocking,
  };
}

/** A revise patch: only the fields the model actually filled in. */
function decodePatch(op: WireOp): Record<string, unknown> {
  return {
    ...set('statement', text(op.statement)),
    ...set('description', text(op.statement)),
    ...set('kind', text(op.kind)),
    ...set('category', text(op.category)),
    ...set('risk', text(op.risk)),
    ...set('priority', text(op.priority)),
    ...set('dimension', text(op.dimension)),
    ...set('blocking', flagToBoolean(op.blocking)),
    ...set('basis', text(op.basis)),
    ...set('rationale', text(op.rationale)),
    ...set('provenance', op.provenance.length === 0 ? undefined : provenanceIn(op.provenance)),
  };
}

export function decodeWireDelta(wire: WireDelta): {
  readonly delta: unknown;
  readonly issues: readonly Issue[];
} {
  const accumulator: DeltaAccumulator = {
    product: decodeProduct(wire.product),
    decisions: { add: [], promote: [] },
    requirements: emptyOps(),
    constraints: emptyOps(),
    assumptions: emptyOps(),
    contradictions: emptyOps(),
  };
  const issues: Issue[] = [];

  wire.ops.forEach((op, index) => {
    const reader = new OpReader(op, index);

    if (op.op === 'add') {
      const content = decodeContent(reader, op, op.target);
      if (op.target === 'decision') accumulator.decisions.add.push(content);
      else accumulator[COLLECTION_KEY[op.target]].add.push(content);
    } else if (op.op === 'promote') {
      const from = reader.need('id');
      const content = decodeContent(reader, op, 'decision');
      accumulator.decisions.promote.push({ ...content, from });
    } else {
      // revise / retire — routed by the id, not by `target`.
      const id = reader.need('id');
      const collection = collectionForId(id);
      if (collection === undefined) {
        if (id !== ABSENT) {
          reader.fail(
            'id',
            `"${id}" does not name an open item. Ids start with one of: ${OPEN_ITEM_PREFIXES.join(', ')}. Decisions are never revised or retired — supersede them instead.`,
          );
        }
      } else if (op.op === 'revise') {
        accumulator[COLLECTION_KEY[collection]].revise.push({
          id,
          reason: reader.need('reason'),
          ...decodePatch(op),
        });
      } else {
        accumulator[COLLECTION_KEY[collection]].retire.push({
          id,
          reason: reader.need('reason'),
        });
      }
    }

    issues.push(...reader.issues);
  });

  return { delta: accumulator, issues };
}

/**
 * Domain → wire. Total, and used only by the round-trip test.
 *
 * Being total is what makes the test meaningful: if a domain field had no wire
 * home, this would not compile, so "the wire covers the domain" is checked by
 * the type system rather than by review.
 */
export function encodeWireDelta(delta: UnderstandingDelta): WireDelta {
  const product = delta.product ?? {};

  const ops: WireOp[] = [];

  const provenanceOut = (
    entries: readonly { sourceId: string; quote: string | null; note: string | null }[] = [],
  ) =>
    entries.map((entry) => ({
      sourceId: entry.sourceId,
      quote: orAbsent(entry.quote),
      note: orAbsent(entry.note),
    }));

  const content = (target: WireTarget, item: Record<string, unknown>): Partial<WireOp> => ({
    target,
    statement: orAbsent((item['statement'] ?? item['description']) as string | null | undefined),
    kind: orAbsent(item['kind'] as string | null | undefined),
    category: orAbsent(item['category'] as string | null | undefined),
    risk: orAbsent(item['risk'] as string | null | undefined),
    priority: orAbsent(item['priority'] as string | null | undefined),
    dimension: orAbsent(item['dimension'] as string | null | undefined),
    blocking: booleanToFlag(item['blocking'] as boolean | undefined),
    basis: orAbsent(item['basis'] as string | null | undefined),
    rationale: orAbsent(item['rationale'] as string | null | undefined),
    settledBySourceId: orAbsent(item['settledBySourceId'] as string | null | undefined),
    supersedes: orAbsent(item['supersedes'] as string | null | undefined),
    provenance: provenanceOut(
      (item['provenance'] ?? item['between'] ?? []) as {
        sourceId: string;
        quote: string | null;
        note: string | null;
      }[],
    ),
  });

  for (const decision of delta.decisions.add) {
    ops.push({ ...emptyOp(), op: 'add', ...content('decision', decision) });
  }
  for (const promotion of delta.decisions.promote) {
    ops.push({
      ...emptyOp(),
      op: 'promote',
      id: promotion.from,
      ...content('decision', promotion),
    });
  }

  for (const [target, key] of Object.entries(COLLECTION_KEY) as [
    Exclude<WireTarget, 'decision'>,
    (typeof COLLECTION_KEY)[keyof typeof COLLECTION_KEY],
  ][]) {
    const collection = delta[key];
    for (const item of collection.add) {
      ops.push({ ...emptyOp(), op: 'add', ...content(target, item) });
    }
    for (const item of collection.revise) {
      const { id, reason, ...patch } = item as Record<string, unknown> & {
        id: string;
        reason: string;
      };
      ops.push({ ...emptyOp(), op: 'revise', id, reason, ...content(target, patch) });
    }
    for (const item of collection.retire) {
      ops.push({ ...emptyOp(), op: 'retire', target, id: item.id, reason: item.reason });
    }
  }

  return {
    product: {
      name: orAbsent(product.name),
      oneLiner: orAbsent(product.oneLiner),
      problem: orAbsent(product.problem),
      purpose: orAbsent(product.purpose),
      users: (product.users ?? []).map((user) => ({
        label: user.label,
        description: orAbsent(user.description),
        needs: [...user.needs],
      })),
    },
    ops,
  };
}

/**
 * The artifact everything else uses.
 *
 * Pass it wherever `UnderstandingDelta` used to go: `generate()` emits the wire
 * schema and returns a domain delta, because a codec's input side is the wire
 * and its output side is the domain.
 */
export const UnderstandingDeltaCodec = z.codec(WireDelta, UnderstandingDelta, {
  decode: (wire, ctx) => {
    const { delta, issues } = decodeWireDelta(wire);
    if (issues.length > 0) {
      for (const issue of issues) {
        ctx.issues.push({
          code: 'custom',
          input: wire,
          path: [...issue.path],
          message: issue.message,
        });
      }
      return z.NEVER;
    }
    // Cast: `decodeWireDelta` builds the delta's *input* shape, which
    // `UnderstandingDelta` then parses — defaults applied, invariants enforced.
    // Nothing here is trusted; the domain schema is still the final gate.
    return delta as z.input<typeof UnderstandingDelta>;
  },
  // `encode` is handed the domain schema's *input* type — collections may be
  // absent, defaults unapplied — so it is normalised first. Re-parsing an
  // already-parsed delta is idempotent, and it keeps `encodeWireDelta` total
  // over the canonical shape rather than over every shape Zod would accept.
  encode: (value) => encodeWireDelta(UnderstandingDelta.parse(value)),
});
export type UnderstandingDeltaCodec = z.infer<typeof UnderstandingDeltaCodec>;
