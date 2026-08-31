import { describe, expect, it } from 'vitest';
import {
  DuplicateIdError,
  UnknownReferenceError,
  UnsettledDecisionError,
} from '../shared/errors.ts';
import { AnswerId } from '../shared/ids.ts';
import { applyDelta } from './apply-delta.ts';
import { UnderstandingDelta } from './delta.ts';
import { currentDecisions, emptyUnderstanding, type Understanding } from './understanding.ts';

const delta = (input: unknown): UnderstandingDelta => UnderstandingDelta.parse(input);

const requirementDraft = (statement: string, overrides: Record<string, unknown> = {}) => ({
  statement,
  kind: 'functional',
  dimension: 'core-behaviour',
  provenance: [{ sourceId: 'src-1', quote: 'from the transcript' }],
  ...overrides,
});

const constraintDraft = (statement: string, overrides: Record<string, unknown> = {}) => ({
  statement,
  category: 'technical',
  dimension: 'constraints',
  ...overrides,
});

const decisionDraft = (statement: string, overrides: Record<string, unknown> = {}) => ({
  statement,
  kind: 'functional',
  dimension: 'core-behaviour',
  rationale: 'chosen over the alternatives',
  ...overrides,
});

/** Seeds an understanding by applying an add-only delta, mirroring real turn 1. */
function seeded(): Understanding {
  return applyDelta(
    emptyUnderstanding(),
    delta({
      requirements: { add: [requirementDraft('Users sign in via SSO')] },
      constraints: { add: [constraintDraft('Must run on Postgres')] },
    }),
  );
}

describe('applyDelta — additions', () => {
  it('mints prefixed ids and appends new entries', () => {
    const result = seeded();

    expect(result.requirements).toHaveLength(1);
    expect(result.requirements[0]?.id).toBe('req-1');
    expect(result.requirements[0]?.statement).toBe('Users sign in via SSO');
    expect(result.constraints[0]?.id).toBe('con-1');
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

  it('never reissues the id of something that was retired', () => {
    // `max + 1` would hand out `req-1` again here. A Question from an earlier
    // turn still storing that id would silently repoint at a different entity.
    const seededOnce = applyDelta(
      emptyUnderstanding(),
      delta({ requirements: { add: [requirementDraft('Doomed requirement')] } }),
    );
    const emptied = applyDelta(
      seededOnce,
      delta({ requirements: { retire: [{ id: 'req-1', reason: 'contradicted' }] } }),
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
        constraints: { add: [constraintDraft('C')] },
      }),
    );

    expect(result.requirements.map((r) => r.id)).toEqual(['req-1', 'req-2']);
    expect(result.constraints.map((c) => c.id)).toEqual(['con-1']);
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

describe('applyDelta — retirements and unknown references', () => {
  it('retires an entry', () => {
    const after = applyDelta(
      seeded(),
      delta({ requirements: { retire: [{ id: 'req-1', reason: 'contradicted by Q2' }] } }),
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
            retire: [
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

describe('applyDelta — promotion', () => {
  it('moves an open item into decisions and removes it from its collection', () => {
    // The answer id comes from the caller's derived map, not from the delta —
    // the model is never asked to transcribe it.
    const after = applyDelta(
      seeded(),
      delta({
        decisions: {
          promote: [{ from: 'req-1', ...decisionDraft('Users sign in via SSO, using Okta') }],
        },
      }),
      { settledBy: new Map([['req-1', AnswerId.parse('ans-1')]]) },
    );

    expect(after.requirements).toHaveLength(0);
    expect(after.decisions).toHaveLength(1);
    expect(after.decisions[0]?.id).toBe('dec-1');
    expect(after.decisions[0]?.promotedFrom).toBe('req-1');
    expect(after.decisions[0]?.settledBy).toBe('ans-1');
    expect(after.decisions[0]?.supersededBy).toBeNull();
    // The promoted id is retired for good: the counter never winds back, so a
    // Question still holding `about: 'req-1'` can never repoint at a new item.
    expect(after.nextIds.requirement).toBe(2);
  });

  it('promotes across collections without caring which one an item came from', () => {
    const after = applyDelta(
      seeded(),
      delta({
        decisions: {
          promote: [{ from: 'con-1', ...decisionDraft('Postgres it is', { kind: 'constraint' }) }],
        },
      }),
      { settledBy: new Map([['con-1', AnswerId.parse('ans-1')]]) },
    );

    expect(after.constraints).toHaveLength(0);
    expect(after.decisions[0]?.promotedFrom).toBe('con-1');
  });

  it('accepts a cited source when no answer settled it', () => {
    const after = applyDelta(
      seeded(),
      delta({
        decisions: {
          promote: [
            { from: 'req-1', ...decisionDraft('SSO via Okta', { settledBySourceId: 'src-1' }) },
          ],
        },
      }),
      { knownSourceIds: new Set(['src-1']) },
    );
    expect(after.decisions[0]?.settledBy).toBe('src-1');
  });

  it('prefers the engine-derived answer over a source the model cited', () => {
    // The engine knows which answer settled which item; the model is guessing.
    // A silent disagreement here would attribute a user's decision to a document.
    const after = applyDelta(
      seeded(),
      delta({
        decisions: {
          promote: [
            { from: 'req-1', ...decisionDraft('SSO via Okta', { settledBySourceId: 'src-1' }) },
          ],
        },
      }),
      {
        settledBy: new Map([['req-1', AnswerId.parse('ans-1')]]),
        knownSourceIds: new Set(['src-1']),
      },
    );
    expect(after.decisions[0]?.settledBy).toBe('ans-1');
  });

  it('rejects a decision that names nothing that settled it', () => {
    expect(() =>
      applyDelta(
        seeded(),
        delta({ decisions: { promote: [{ from: 'req-1', ...decisionDraft('Unfounded') }] } }),
      ),
    ).toThrow(UnsettledDecisionError);
  });

  it('rejects a cited source that does not exist', () => {
    expect(() =>
      applyDelta(
        seeded(),
        delta({
          decisions: {
            promote: [{ from: 'req-1', ...decisionDraft('X', { settledBySourceId: 'src-99' }) }],
          },
        }),
        { knownSourceIds: new Set(['src-1']) },
      ),
    ).toThrow(UnknownReferenceError);
  });

  it('rejects promoting an item that does not exist', () => {
    expect(() =>
      applyDelta(
        seeded(),
        delta({ decisions: { promote: [{ from: 'req-99', ...decisionDraft('Invented') }] } }),
      ),
    ).toThrow(UnknownReferenceError);
  });

  it('rejects promoting the same item twice in one delta', () => {
    expect(() =>
      applyDelta(
        seeded(),
        delta({
          decisions: {
            promote: [
              { from: 'req-1', ...decisionDraft('One') },
              { from: 'req-1', ...decisionDraft('Two') },
            ],
          },
        }),
        { settledBy: new Map([['req-1', AnswerId.parse('ans-1')]]) },
      ),
    ).toThrow(DuplicateIdError);
  });

  it('adds a decision with no open item behind it', () => {
    const after = applyDelta(
      emptyUnderstanding(),
      delta({
        decisions: { add: [decisionDraft('Ship on Postgres', { settledBySourceId: 'src-1' })] },
      }),
      { knownSourceIds: new Set(['src-1']) },
    );
    expect(after.decisions[0]?.promotedFrom).toBeNull();
    expect(after.decisions[0]?.settledBy).toBe('src-1');
  });
});

describe('applyDelta — supersession', () => {
  const withOneDecision = (): Understanding =>
    applyDelta(
      emptyUnderstanding(),
      delta({
        decisions: { add: [decisionDraft('Use magic links', { settledBySourceId: 'src-1' })] },
      }),
      { knownSourceIds: new Set(['src-1']) },
    );

  it('marks the old record and keeps it', () => {
    // ADR rule: an accepted record is never edited and never deleted. The trail
    // of supersessions is the history, so `decisions[]` grows monotonically.
    const after = applyDelta(
      withOneDecision(),
      delta({
        decisions: {
          add: [decisionDraft('Use SSO', { settledBySourceId: 'src-1', supersedes: 'dec-1' })],
        },
      }),
      { knownSourceIds: new Set(['src-1']) },
    );

    expect(after.decisions).toHaveLength(2);
    expect(after.decisions[0]?.supersededBy).toBe('dec-2');
    expect(after.decisions[1]?.supersededBy).toBeNull();
    expect(currentDecisions(after).map((d) => d.id)).toEqual(['dec-2']);
  });

  it('rejects superseding a decision that does not exist', () => {
    expect(() =>
      applyDelta(
        withOneDecision(),
        delta({
          decisions: {
            add: [decisionDraft('X', { settledBySourceId: 'src-1', supersedes: 'dec-99' })],
          },
        }),
        { knownSourceIds: new Set(['src-1']) },
      ),
    ).toThrow(UnknownReferenceError);
  });

  it('rejects superseding a decision that was already superseded', () => {
    // Means the model was reasoning about state two revisions stale. Allowing it
    // would fork the chain into a shape no projection can render.
    const once = applyDelta(
      withOneDecision(),
      delta({
        decisions: {
          add: [decisionDraft('Use SSO', { settledBySourceId: 'src-1', supersedes: 'dec-1' })],
        },
      }),
      { knownSourceIds: new Set(['src-1']) },
    );

    expect(() =>
      applyDelta(
        once,
        delta({
          decisions: {
            add: [decisionDraft('Use OTP', { settledBySourceId: 'src-1', supersedes: 'dec-1' })],
          },
        }),
        { knownSourceIds: new Set(['src-1']) },
      ),
    ).toThrow(UnknownReferenceError);
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
