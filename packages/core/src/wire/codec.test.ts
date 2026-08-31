import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { applyDelta, emptyUnderstanding, UnderstandingDelta } from '../domain/index.ts';
import { measureBudget } from './budget.ts';
import { UnderstandingDeltaCodec } from './codec.ts';
import { DELTA_EXAMPLE, emptyOp, emptyWireDelta, type WireDelta, type WireOp } from './delta.ts';

/**
 * The wire is a contract with two readers — a grammar compiler and the domain —
 * and every test here pins one of them.
 */

const wire = (ops: readonly Partial<WireOp>[], product: Partial<WireDelta['product']> = {}) => ({
  ...emptyWireDelta(),
  product: { ...emptyWireDelta().product, ...product },
  ops: ops.map((op) => ({ ...emptyOp(), ...op })),
});

const decode = (input: ReturnType<typeof wire>) => UnderstandingDeltaCodec.parse(input);

const issuesOf = (input: ReturnType<typeof wire>): string[] => {
  const result = UnderstandingDeltaCodec.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
};

describe('the wire schema fits inside a decoding grammar', () => {
  /**
   * The constraint as an executable rule. Adding a field to `WireOp` that Zod
   * emits as optional or as a union fails CI here rather than in production —
   * which is the difference between this design and a note in a document.
   */
  const CAPS = { optional: 24, union: 16 };

  // One measurer, shared with the adapters that read it at runtime. It used to
  // be three copies of the same walker — here, in `anthropic.ts`, and in a probe
  // — which is three chances for the CI budget and the runtime check to disagree
  // about what they are counting.
  const shape = (schema: z.ZodType<unknown>, io: 'input' | 'output' = 'input') =>
    measureBudget(schema, io);

  it('emits zero optional properties and stays under both caps', () => {
    const measured = shape(UnderstandingDeltaCodec);

    // Reported, because the headroom is the interesting number: the whole point
    // is that a future field has somewhere to go.
    console.info(
      `[wire] ${measured.optional} optional / ${measured.union} union / ${(measured.bytes / 1024).toFixed(1)} KB`,
    );

    expect(measured.optional).toBe(0);
    expect(measured.union).toBeLessThanOrEqual(CAPS.union);
    expect(measured.optional).toBeLessThanOrEqual(CAPS.optional);
  });

  it('is dramatically cheaper than the domain delta it replaces', () => {
    // The domain delta is not sendable and is not meant to be. Asserting the gap
    // rather than only the absolute number is what stops someone "simplifying"
    // the codec away by pointing the generator back at the domain schema.
    const domain = shape(UnderstandingDelta);
    const onWire = shape(UnderstandingDeltaCodec);

    expect(domain.optional).toBeGreaterThan(CAPS.optional);
    expect(onWire.bytes * 3).toBeLessThan(domain.bytes);
  });

  it("puts the sentinel inside the enum rather than in a union with ''", () => {
    // `z.enum(['','low']).` is one `enum` keyword; `z.enum(['low']).nullable()`
    // is an `anyOf`. This is the single trick the union budget depends on.
    const text = JSON.stringify(z.toJSONSchema(UnderstandingDeltaCodec, { io: 'input' }));
    expect(text).toContain('""');
    expect(text).not.toContain('"null"');
  });
});

describe('decode — wire to domain', () => {
  it('turns a flat op list into per-collection operations', () => {
    const delta = decode(
      wire([
        {
          op: 'add',
          target: 'requirement',
          statement: 'Sign in via SSO',
          kind: 'functional',
          dimension: 'core-behaviour',
        },
        {
          op: 'add',
          target: 'constraint',
          statement: 'On-premise only',
          category: 'technical',
          dimension: 'constraints',
        },
      ]),
    );

    expect(delta.requirements.add).toHaveLength(1);
    expect(delta.constraints.add).toHaveLength(1);
    expect(delta.requirements.add[0]?.statement).toBe('Sign in via SSO');
  });

  it('maps the absent sentinel to null rather than to an empty string', () => {
    const delta = decode(
      wire([
        {
          op: 'add',
          target: 'requirement',
          statement: 'Sign in via SSO',
          kind: 'functional',
          dimension: 'core-behaviour',
          provenance: [{ sourceId: 'src-1', quote: 'we use Okta', note: '' }],
        },
      ]),
    );

    const requirement = delta.requirements.add[0];
    expect(requirement?.rationale).toBeNull();
    expect(requirement?.priority).toBeNull();
    expect(requirement?.provenance[0]?.quote).toBe('we use Okta');
    expect(requirement?.provenance[0]?.note).toBeNull();
  });

  it('routes revise and retire by the id prefix, ignoring a mistaken target', () => {
    // The two can disagree and one has to win. Failing here would cost a whole
    // turn over a redundancy the wire introduced itself.
    const delta = decode(
      wire([{ op: 'retire', target: 'requirement', id: 'con-2', reason: 'withdrawn' }]),
    );

    expect(delta.constraints.retire).toHaveLength(1);
    expect(delta.requirements.retire).toHaveLength(0);
  });

  it('sends only the fields a revise actually filled in', () => {
    const delta = decode(
      wire([{ op: 'revise', id: 'req-1', reason: 'confirmed', priority: 'must' }]),
    );

    const revision = delta.requirements.revise[0];
    expect(revision?.priority).toBe('must');
    // Everything else must be genuinely absent — a present-but-undefined key
    // would be spread over the entity and erase it.
    expect(revision).not.toHaveProperty('statement');
    expect(revision).not.toHaveProperty('rationale');
  });

  it('carries a three-state blocking flag, so a revise cannot silently clear it', () => {
    const untouched = decode(wire([{ op: 'revise', id: 'req-1', reason: 'x' }]));
    expect(untouched.requirements.revise[0]).not.toHaveProperty('blocking');

    const cleared = decode(wire([{ op: 'revise', id: 'req-1', reason: 'x', blocking: 'no' }]));
    expect(cleared.requirements.revise[0]?.blocking).toBe(false);
  });

  it('reads the promoted item from `id`, with no second way to name it', () => {
    const delta = decode(
      wire([
        {
          op: 'promote',
          target: 'decision',
          id: 'req-1',
          statement: 'Sign-in is SSO via Okta',
          kind: 'functional',
          dimension: 'core-behaviour',
          rationale: 'The only provider already in use',
        },
      ]),
    );

    expect(delta.decisions.promote[0]?.from).toBe('req-1');
    expect(delta.decisions.promote[0]?.settledBySourceId).toBeNull();
  });

  it('collapses an all-empty product to "no change"', () => {
    expect(decode(wire([])).product).toBeNull();
    expect(decode(wire([], { name: 'Requirely' })).product).toEqual({ name: 'Requirely' });
  });
});

describe('decode — failures are reported at wire paths and are retryable', () => {
  it('reports a missing required field against the op the model wrote', () => {
    const issues = issuesOf(wire([{ op: 'add', target: 'requirement', statement: 'X' }]));

    // `ops.0.kind`, not `requirements.add.0.kind` — a reask has to name
    // something that exists in the schema the model was given.
    expect(issues).toContain('ops.0.kind: `kind` is required for op "add" on a requirement.');
    expect(issues.some((issue) => issue.startsWith('ops.0.dimension'))).toBe(true);
  });

  it('names the contradiction rule at the field that broke it', () => {
    const issues = issuesOf(
      wire([
        {
          op: 'add',
          target: 'contradiction',
          statement: 'Retention is both 30 and 90 days',
          dimension: 'data',
          provenance: [{ sourceId: 'src-1', quote: '', note: '' }],
        },
      ]),
    );

    expect(issues.some((issue) => issue.startsWith('ops.0.provenance'))).toBe(true);
  });

  it('explains that a decision is superseded, never revised', () => {
    const issues = issuesOf(wire([{ op: 'revise', id: 'dec-1', reason: 'wrong' }]));
    expect(issues.join(' ')).toContain('supersede');
  });

  it('fails as a ZodError, so the retry decorator can re-ask instead of losing the turn', () => {
    const result = UnderstandingDeltaCodec.safeParse(wire([{ op: 'add', target: 'assumption' }]));
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(z.ZodError);
  });

  it('still lets the domain be the final gate', () => {
    // `decode` narrows per kind; the domain schema is what rejects a kind that
    // is valid for a decision but not for a requirement.
    const issues = issuesOf(
      wire([
        { op: 'add', target: 'requirement', statement: 'X', kind: 'scope', dimension: 'data' },
      ]),
    );
    expect(issues.some((issue) => issue.includes('kind'))).toBe(true);
  });
});

describe('round-trip — the property that makes drift a CI failure', () => {
  const CASES: Record<string, unknown> = {
    empty: {},
    'product patch': { product: { name: 'Requirely', purpose: 'Gather requirements faster' } },
    'product with users': {
      product: { users: [{ label: 'PMs', description: 'write specs', needs: ['fewer rounds'] }] },
    },
    additions: {
      requirements: {
        add: [
          {
            statement: 'Sign in via SSO',
            kind: 'functional',
            dimension: 'core-behaviour',
            priority: 'must',
            rationale: 'Okta is already deployed',
            blocking: true,
            provenance: [{ sourceId: 'src-1', quote: 'we use Okta' }],
          },
        ],
      },
      constraints: {
        add: [{ statement: 'On-premise', category: 'regulatory', dimension: 'constraints' }],
      },
      assumptions: {
        add: [
          {
            statement: 'English only',
            basis: 'no locale mentioned',
            risk: 'low',
            dimension: 'edge-cases',
          },
        ],
      },
      contradictions: {
        add: [
          {
            description: 'Retention is both 30 and 90 days',
            between: [{ sourceId: 'src-1' }, { sourceId: 'src-2' }],
            dimension: 'data',
          },
        ],
      },
    },
    'revise and retire': {
      requirements: {
        revise: [{ id: 'req-1', priority: 'should', reason: 'downgraded' }],
        retire: [{ id: 'req-2', reason: 'contradicted' }],
      },
    },
    decisions: {
      decisions: {
        add: [
          {
            statement: 'Ship on Postgres',
            kind: 'constraint',
            dimension: 'constraints',
            rationale: 'Already operated in house',
            settledBySourceId: 'src-1',
            supersedes: 'dec-1',
          },
        ],
        promote: [
          {
            from: 'req-1',
            statement: 'Sign-in is SSO via Okta',
            kind: 'functional',
            dimension: 'core-behaviour',
            rationale: 'Chosen over magic links',
          },
        ],
      },
    },
  };

  for (const [name, input] of Object.entries(CASES)) {
    it(`survives decode(encode(x)) — ${name}`, () => {
      const original = UnderstandingDelta.parse(input);
      const encoded = z.encode(UnderstandingDeltaCodec, original);
      expect(UnderstandingDeltaCodec.parse(encoded)).toEqual(original);
    });
  }

  it('covers every domain field, or `encode` would not compile', () => {
    // The real guarantee is structural: `encodeWireDelta` takes a complete
    // `UnderstandingDelta`, so a new domain field with no wire home is a type
    // error. This case exists so the claim is visible in the test names too.
    const everything = UnderstandingDelta.parse(CASES['additions']);
    expect(z.encode(UnderstandingDeltaCodec, everything).ops).toHaveLength(4);
  });
});

describe('the limitations, pinned rather than discovered later', () => {
  it('cannot clear a nullable field through a revise', () => {
    // `''` already means "leave alone", so it cannot also mean "set to null".
    // The escape hatch is retire + add, and this test is what stops the
    // limitation being rediscovered mid-session.
    const original = UnderstandingDelta.parse({
      requirements: { revise: [{ id: 'req-1', rationale: null, reason: 'no longer applies' }] },
    });
    const round = UnderstandingDeltaCodec.parse(z.encode(UnderstandingDeltaCodec, original));

    expect(original.requirements.revise[0]).toHaveProperty('rationale', null);
    expect(round.requirements.revise[0]).not.toHaveProperty('rationale');
  });

  it('produces a delta the domain can actually apply', () => {
    // The point of the whole layer: what comes out the far side is an ordinary
    // domain delta, indistinguishable from a hand-written one.
    const delta = decode(
      wire([
        {
          op: 'add',
          target: 'requirement',
          statement: 'Sign in via SSO',
          kind: 'functional',
          dimension: 'core-behaviour',
        },
      ]),
    );
    const after = applyDelta(emptyUnderstanding(), delta);
    expect(after.requirements[0]?.id).toBe('req-1');
  });
});

describe('the worked example, which a prompted call teaches from', () => {
  it('is a valid wire delta, so a drifting example fails CI rather than a session', () => {
    // An example is a prompt, and a prompt that teaches the wrong shape is worse
    // than no prompt at all: it produces confidently malformed output on the one
    // method with no structural guarantee to catch it.
    expect(() => UnderstandingDeltaCodec.parse(DELTA_EXAMPLE)).not.toThrow();
  });

  it('demonstrates the two ops a model most often gets wrong', () => {
    // `add` leaves `id` empty; `promote` puts the *open item* in `id`, not the
    // decision being created. Everything else is inferable from the schema.
    const ops = DELTA_EXAMPLE.ops.map((op) => op.op);
    expect(ops).toEqual(['add', 'promote']);
    expect(DELTA_EXAMPLE.ops[0]?.id).toBe('');
    expect(DELTA_EXAMPLE.ops[1]?.id).toMatch(/^req-/);
  });

  it('decodes into something the domain can apply', () => {
    const delta = UnderstandingDeltaCodec.parse(DELTA_EXAMPLE);
    expect(delta.requirements.add).toHaveLength(1);
    expect(delta.decisions.promote[0]?.from).toBe('req-4');
  });
});
