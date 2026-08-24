import { describe, expect, it } from 'vitest';
import { DuplicateIdError, UnknownReferenceError } from '../shared/errors.ts';
import { AnswerId } from '../shared/ids.ts';
import { applyDelta } from './apply-delta.ts';
import { UnderstandingDelta } from './delta.ts';
import { emptyUnderstanding, type Understanding } from './understanding.ts';

const delta = (input: unknown): UnderstandingDelta => UnderstandingDelta.parse(input);

const requirementDraft = (statement: string, overrides: Record<string, unknown> = {}) => ({
  statement,
  kind: 'functional',
  provenance: [{ sourceId: 'src-1', quote: 'from the transcript' }],
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
  );
}

describe('applyDelta — additions', () => {
  it('mints prefixed ids and appends new entries', () => {
    const result = seeded();

    expect(result.requirements).toHaveLength(1);
    expect(result.requirements[0]?.id).toBe('req-1');
    expect(result.requirements[0]?.statement).toBe('Users sign in via SSO');
    expect(result.gaps[0]?.id).toBe('gap-1');
  });

  it('treats an empty delta as the identity function', () => {
    const before = seeded();
    expect(applyDelta(before, delta({}))).toEqual(before);
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
          revise: [{ id: 'req-1', priority: 'must', reason: 'confirmed by the answer to Q1' }],
        },
      }),
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
    );

    const untouched = applyDelta(
      before,
      delta({ requirements: { revise: [{ id: 'req-1', reason: 'unrelated tweak' }] } }),
    );
    expect(untouched.requirements[0]?.rationale).toBe('because');

    const cleared = applyDelta(
      before,
      delta({
        requirements: { revise: [{ id: 'req-1', rationale: null, reason: 'no longer applies' }] },
      }),
    );
    expect(cleared.requirements[0]?.rationale).toBeNull();
  });

  it('keeps ids stable and increasing across successive turns', () => {
    // No shared generator to thread through: the counter travels in the
    // document, so two independent calls cannot collide by construction.
    const turn1 = applyDelta(
      emptyUnderstanding(),
      delta({ requirements: { add: [requirementDraft('Users sign in via SSO')] } }),
    );
    const turn2 = applyDelta(
      turn1,
      delta({ requirements: { add: [requirementDraft('Users can revoke a session')] } }),
    );

    expect(turn2.requirements.map((r) => r.id)).toEqual(['req-1', 'req-2']);
    expect(turn2.requirements[0]?.statement).toBe('Users sign in via SSO');
    expect(turn2.nextIds.requirement).toBe(3);
  });

  it('never reissues the id of something that was removed', () => {
    // `max + 1` would hand out `req-1` again here. A Question from an earlier
    // turn still storing that id would silently repoint at a different entity.
    const seededOnce = applyDelta(
      emptyUnderstanding(),
      delta({ requirements: { add: [requirementDraft('Doomed requirement')] } }),
    );
    const emptied = applyDelta(
      seededOnce,
      delta({ requirements: { remove: [{ id: 'req-1', reason: 'contradicted' }] } }),
    );
    const refilled = applyDelta(
      emptied,
      delta({ requirements: { add: [requirementDraft('Replacement')] } }),
    );

    expect(emptied.requirements).toHaveLength(0);
    expect(refilled.requirements[0]?.id).toBe('req-2');
  });

  it('counts each collection independently', () => {
    const result = applyDelta(
      emptyUnderstanding(),
      delta({
        requirements: { add: [requirementDraft('A'), requirementDraft('B')] },
        gaps: { add: [gapDraft('audience')] },
      }),
    );

    expect(result.requirements.map((r) => r.id)).toEqual(['req-1', 'req-2']);
    expect(result.gaps.map((g) => g.id)).toEqual(['gap-1']);
  });

  it('rejects a document whose counter disagrees with its contents', () => {
    // Unreachable in normal operation; this is the guard against hand-edited
    // JSONB or a bad migration, where the counter has been wound backwards.
    const tampered = {
      ...seeded(),
      nextIds: { ...seeded().nextIds, requirement: 1 },
    };

    expect(() =>
      applyDelta(tampered, delta({ requirements: { add: [requirementDraft('Collides')] } })),
    ).toThrow(DuplicateIdError);
  });
});

describe('applyDelta — removals and unknown references', () => {
  it('removes an entry', () => {
    const after = applyDelta(
      seeded(),
      delta({ requirements: { remove: [{ id: 'req-1', reason: 'contradicted by Q2' }] } }),
    );
    expect(after.requirements).toHaveLength(0);
  });

  it('rejects a revision of an unknown id rather than silently ignoring it', () => {
    expect(() =>
      applyDelta(
        seeded(),
        delta({ requirements: { revise: [{ id: 'req-99', reason: 'hallucinated' }] } }),
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
              { id: 'req-98', reason: 'nope' },
              { id: 'req-99', reason: 'nope' },
            ],
          },
        }),
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as UnknownReferenceError).references).toEqual(['req-98', 'req-99']);
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
            revise: [{ id: 'req-99', reason: 'hallucinated' }],
          },
        }),
      ),
    ).toThrow(UnknownReferenceError);
    expect(before.requirements).toHaveLength(1);
  });
});

describe('applyDelta — gap resolution', () => {
  it('moves a resolved gap out of gaps and records what was learned', () => {
    // The answer id comes from the caller's derived map, not from the delta —
    // the model is never asked to transcribe it.
    const after = applyDelta(
      seeded(),
      delta({
        gaps: {
          resolve: [{ id: 'gap-1', resolution: 'Sessions end after 30 days of inactivity.' }],
        },
      }),
      { resolvedBy: new Map([['gap-1', AnswerId.parse('ans-1')]]) },
    );

    expect(after.gaps).toHaveLength(0);
    expect(after.resolvedGaps).toHaveLength(1);
    expect(after.resolvedGaps[0]?.id).toBe('gap-1');
    expect(after.resolvedGaps[0]?.resolvedByAnswerId).toBe('ans-1');
    expect(after.resolvedGaps[0]?.topic).toBe('sign-out behaviour');
  });

  it('records a null answer id when no answer closed the gap', () => {
    const after = applyDelta(
      seeded(),
      delta({ gaps: { resolve: [{ id: 'gap-1', resolution: 'closed by a new source' }] } }),
    );
    expect(after.resolvedGaps[0]?.resolvedByAnswerId).toBeNull();
  });

  it('ignores a resolvedByAnswerId the model tries to supply', () => {
    // The field is not in the schema, so Zod strips it. Asserting that here
    // pins the contract: the engine owns this value, not the model.
    const parsed = UnderstandingDelta.parse({
      gaps: { resolve: [{ id: 'gap-1', resolution: 'x', resolvedByAnswerId: 'ans-99' }] },
    });
    expect(parsed.gaps.resolve[0]).not.toHaveProperty('resolvedByAnswerId');
  });

  it('rejects resolving a gap that is not open', () => {
    expect(() =>
      applyDelta(
        seeded(),
        delta({ gaps: { resolve: [{ id: 'gap-99', resolution: 'invented' }] } }),
      ),
    ).toThrow(UnknownReferenceError);
  });

  it('accumulates resolved gaps across turns rather than replacing them', () => {
    const turn1 = applyDelta(
      seeded(),
      delta({ gaps: { resolve: [{ id: 'gap-1', resolution: 'answered' }] } }),
    );
    const withNewGap = applyDelta(turn1, delta({ gaps: { add: [gapDraft('data retention')] } }));
    const turn2 = applyDelta(
      withNewGap,
      delta({ gaps: { resolve: [{ id: 'gap-2', resolution: 'also answered' }] } }),
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
    );

    const after = applyDelta(before, delta({ product: { oneLiner: 'Plan mode on steroids' } }));

    expect(after.product.name).toBe('Requirely');
    expect(after.product.purpose).toBe('Gather requirements faster');
    expect(after.product.oneLiner).toBe('Plan mode on steroids');
  });

  it('leaves the product untouched when the delta omits it', () => {
    const before = applyDelta(emptyUnderstanding(), delta({ product: { name: 'Requirely' } }));
    expect(applyDelta(before, delta({})).product.name).toBe('Requirely');
  });
});
