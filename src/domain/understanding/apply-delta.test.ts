import { describe, expect, it } from 'vitest';
import { DuplicateIdError, UnknownReferenceError } from '../shared/errors.ts';
import { sequentialIdGenerator } from '../testing/fakes.ts';
import { applyDelta } from './apply-delta.ts';
import { UnderstandingDelta } from './delta.ts';
import { emptyUnderstanding, type Understanding } from './understanding.ts';

const ctx = () => ({ ids: sequentialIdGenerator() });
const delta = (input: unknown): UnderstandingDelta => UnderstandingDelta.parse(input);

const requirementDraft = (statement: string, overrides: Record<string, unknown> = {}) => ({
  statement,
  kind: 'functional',
  provenance: [{ sourceId: 'src_1', quote: 'from the transcript' }],
  ...overrides,
});

const gapDraft = (topic: string, overrides: Record<string, unknown> = {}) => ({
  dimension: 'acceptance',
  topic,
  description: `We do not know about ${topic}.`,
  blocking: true,
  impact: 'high',
  ...overrides,
});

/** Seeds an understanding by applying an add-only delta, mirroring real turn 1. */
function seeded(): Understanding {
  return applyDelta(
    emptyUnderstanding(),
    delta({
      requirements: { add: [requirementDraft('Users sign in via SSO')] },
      gaps: { add: [gapDraft('sign-out behaviour')] },
    }),
    ctx(),
  );
}

describe('applyDelta — additions', () => {
  it('mints prefixed ids and appends new entries', () => {
    const result = seeded();

    expect(result.requirements).toHaveLength(1);
    expect(result.requirements[0]?.id).toBe('req_1');
    expect(result.requirements[0]?.statement).toBe('Users sign in via SSO');
    expect(result.gaps[0]?.id).toBe('gap_1');
  });

  it('treats an empty delta as the identity function', () => {
    const before = seeded();
    expect(applyDelta(before, delta({}), ctx())).toEqual(before);
  });

  it('produces output that survives a JSONB round-trip unchanged', () => {
    const result = seeded();
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe('applyDelta — revisions', () => {
  it('patches only the named fields and preserves provenance', () => {
    const before = seeded();

    const after = applyDelta(
      before,
      delta({
        requirements: {
          revise: [{ id: 'req_1', priority: 'must', reason: 'confirmed by the answer to Q1' }],
        },
      }),
      ctx(),
    );

    expect(after.requirements[0]?.priority).toBe('must');
    // Untouched fields must survive — this is the whole point of deltas over
    // regeneration, and the thing full-rewrite would silently lose.
    expect(after.requirements[0]?.statement).toBe('Users sign in via SSO');
    expect(after.requirements[0]?.provenance).toEqual(before.requirements[0]?.provenance);
  });

  it('clears a field only when an explicit null is sent', () => {
    const before = applyDelta(
      emptyUnderstanding(),
      delta({ requirements: { add: [requirementDraft('X', { rationale: 'because' })] } }),
      ctx(),
    );

    const untouched = applyDelta(
      before,
      delta({ requirements: { revise: [{ id: 'req_1', reason: 'unrelated tweak' }] } }),
      ctx(),
    );
    expect(untouched.requirements[0]?.rationale).toBe('because');

    const cleared = applyDelta(
      before,
      delta({
        requirements: { revise: [{ id: 'req_1', rationale: null, reason: 'no longer applies' }] },
      }),
      ctx(),
    );
    expect(cleared.requirements[0]?.rationale).toBeNull();
  });

  it('keeps ids stable across successive turns', () => {
    // One generator across both turns, as a running engine has. An earlier
    // version of this test built a fresh generator per turn and then asserted
    // `['req_1', 'req_1']` — documenting an id collision as correct behaviour.
    const shared = { ids: sequentialIdGenerator() };

    const turn1 = applyDelta(
      emptyUnderstanding(),
      delta({ requirements: { add: [requirementDraft('Users sign in via SSO')] } }),
      shared,
    );
    const turn2 = applyDelta(
      turn1,
      delta({ requirements: { add: [requirementDraft('Users can revoke a session')] } }),
      shared,
    );

    expect(turn2.requirements.map((r) => r.id)).toEqual(['req_1', 'req_2']);
    expect(turn2.requirements[0]?.statement).toBe('Users sign in via SSO');
  });

  it('refuses to mint an id that a collection already uses', () => {
    const turn1 = seeded();

    // A generator that restarts hands back `req_1` a second time. Real
    // generators do not, but the collection's uniqueness must not depend on
    // that: two requirements sharing an id makes every later revise ambiguous.
    expect(() =>
      applyDelta(
        turn1,
        delta({ requirements: { add: [requirementDraft('Colliding requirement')] } }),
        ctx(),
      ),
    ).toThrow(DuplicateIdError);
  });
});

describe('applyDelta — removals and unknown references', () => {
  it('removes an entry', () => {
    const after = applyDelta(
      seeded(),
      delta({ requirements: { remove: [{ id: 'req_1', reason: 'contradicted by Q2' }] } }),
      ctx(),
    );
    expect(after.requirements).toHaveLength(0);
  });

  it('rejects a revision of an unknown id rather than silently ignoring it', () => {
    expect(() =>
      applyDelta(
        seeded(),
        delta({ requirements: { revise: [{ id: 'req_99', reason: 'hallucinated' }] } }),
        ctx(),
      ),
    ).toThrow(UnknownReferenceError);
  });

  it('names every unknown id in the error', () => {
    try {
      applyDelta(
        seeded(),
        delta({
          requirements: {
            remove: [
              { id: 'req_98', reason: 'nope' },
              { id: 'req_99', reason: 'nope' },
            ],
          },
        }),
        ctx(),
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as UnknownReferenceError).references).toEqual(['req_98', 'req_99']);
    }
  });

  it('applies the whole delta or none of it', () => {
    const before = seeded();
    expect(() =>
      applyDelta(
        before,
        delta({
          requirements: {
            add: [requirementDraft('Should not be applied')],
            revise: [{ id: 'req_99', reason: 'hallucinated' }],
          },
        }),
        ctx(),
      ),
    ).toThrow(UnknownReferenceError);
    expect(before.requirements).toHaveLength(1);
  });
});

describe('applyDelta — gap resolution', () => {
  it('moves a resolved gap out of gaps and records what was learned', () => {
    const after = applyDelta(
      seeded(),
      delta({
        gaps: {
          resolve: [
            {
              id: 'gap_1',
              resolvedByAnswerId: 'ans_1',
              resolution: 'Sessions end after 30 days of inactivity.',
            },
          ],
        },
      }),
      ctx(),
    );

    expect(after.gaps).toHaveLength(0);
    expect(after.resolvedGaps).toHaveLength(1);
    expect(after.resolvedGaps[0]?.id).toBe('gap_1');
    expect(after.resolvedGaps[0]?.resolvedByAnswerId).toBe('ans_1');
    expect(after.resolvedGaps[0]?.topic).toBe('sign-out behaviour');
  });

  it('rejects resolving a gap that is not open', () => {
    expect(() =>
      applyDelta(
        seeded(),
        delta({ gaps: { resolve: [{ id: 'gap_99', resolution: 'invented' }] } }),
        ctx(),
      ),
    ).toThrow(UnknownReferenceError);
  });

  it('accumulates resolved gaps across turns rather than replacing them', () => {
    const turn1 = applyDelta(
      seeded(),
      delta({ gaps: { resolve: [{ id: 'gap_1', resolution: 'answered' }] } }),
      ctx(),
    );
    const turn2Ctx = ctx();
    const withNewGap = applyDelta(
      turn1,
      delta({ gaps: { add: [gapDraft('data retention')] } }),
      turn2Ctx,
    );
    const turn2 = applyDelta(
      withNewGap,
      delta({ gaps: { resolve: [{ id: 'gap_1', resolution: 'also answered' }] } }),
      turn2Ctx,
    );

    expect(turn2.resolvedGaps).toHaveLength(2);
    expect(turn2.gaps).toHaveLength(0);
  });
});

describe('applyDelta — product summary', () => {
  it('merges a partial patch without clobbering unmentioned fields', () => {
    const before = applyDelta(
      emptyUnderstanding(),
      delta({ product: { name: 'Requirely', purpose: 'Gather requirements faster' } }),
      ctx(),
    );

    const after = applyDelta(
      before,
      delta({ product: { oneLiner: 'Plan mode on steroids' } }),
      ctx(),
    );

    expect(after.product.name).toBe('Requirely');
    expect(after.product.purpose).toBe('Gather requirements faster');
    expect(after.product.oneLiner).toBe('Plan mode on steroids');
  });

  it('leaves the product untouched when the delta omits it', () => {
    const before = applyDelta(
      emptyUnderstanding(),
      delta({ product: { name: 'Requirely' } }),
      ctx(),
    );
    expect(applyDelta(before, delta({}), ctx()).product.name).toBe('Requirely');
  });
});
