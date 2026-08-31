import { describe, expect, it } from 'vitest';
import { type ZodType, z } from 'zod';
import { Answer } from './inquiry/answer.ts';
import { Question } from './inquiry/question.ts';
import { Session } from './session/session.ts';
import { Source } from './source/source.ts';
import { UnderstandingAssessment } from './sufficiency/coverage.ts';
import { SufficiencyVerdict } from './sufficiency/verdict.ts';
import { Turn } from './turn/turn.ts';
import { UnderstandingDelta } from './understanding/delta.ts';
import { UnderstandingRevision } from './understanding/understanding.ts';

/**
 * The JSONB storage contract, asserted before any storage layer exists.
 *
 * Understanding revisions, verdicts, and turns are persisted as JSON. If any
 * entity loses or mutates a field across `JSON.parse(JSON.stringify(x))`, then
 * what is written and what is read back diverge — a class of bug that surfaces
 * as an inexplicable missing field weeks later. Every nullable-instead-of-
 * optional choice in the domain exists to make this test pass.
 */
function assertRoundTrips<T>(schema: ZodType<T>, value: T): void {
  const revived = JSON.parse(JSON.stringify(value)) as unknown;
  expect(revived).toEqual(value);
  expect(schema.parse(revived)).toEqual(value);
}

const timestamp = '2026-01-01T00:00:00.000Z';

const verdict = SufficiencyVerdict.parse({
  sufficient: false,
  rationale: 'Not yet sufficient: coverage below the 0.70 bar for: acceptance (0.25).',
  coverage: [{ dimension: 'acceptance', score: 0.25, rationale: 'no acceptance criteria stated' }],
  shortfalls: ['acceptance'],
  blockingItemIds: ['req-1'],
  questionsAsked: 2,
  questionBudget: 12,
  budgetExhausted: false,
});

const revision = UnderstandingRevision.parse({
  id: 'rev-1',
  sessionId: 'ses-1',
  revision: 1,
  producedByTurnId: 'trn-1',
  createdAt: timestamp,
  content: {
    product: { name: 'Requirely', users: [{ label: 'Product managers', needs: ['faster specs'] }] },
    decisions: [
      {
        id: 'dec-1',
        statement: 'Sign-in is SSO via Okta',
        kind: 'functional',
        dimension: 'core-behaviour',
        rationale: 'The only identity provider already in use.',
        promotedFrom: 'req-9',
        settledBy: 'ans-1',
        provenance: [{ sourceId: 'src-1', quote: 'we use Okta' }],
      },
      // A superseded record, because the supersession chain is the part most
      // likely to be lost in a JSONB round-trip and the part nothing else pins.
      {
        id: 'dec-0',
        statement: 'Sign-in is magic links',
        kind: 'functional',
        dimension: 'core-behaviour',
        rationale: 'Superseded once Okta was confirmed.',
        settledBy: 'src-1',
        supersededBy: 'dec-1',
      },
    ],
    requirements: [
      {
        id: 'req-1',
        statement: 'Users sign in via SSO',
        kind: 'functional',
        dimension: 'core-behaviour',
        blocking: true,
        provenance: [{ sourceId: 'src-1', quote: 'we use Okta' }],
      },
    ],
    constraints: [
      {
        id: 'con-1',
        statement: 'Must run on-premise',
        category: 'technical',
        dimension: 'constraints',
      },
    ],
    assumptions: [
      {
        id: 'asm-1',
        statement: 'English only at launch',
        basis: 'no locale mentioned',
        risk: 'low',
        dimension: 'edge-cases',
      },
    ],
    contradictions: [
      {
        id: 'ctr-1',
        description: 'Retention stated as both 30 and 90 days',
        between: [{ sourceId: 'src-1' }, { sourceId: 'src-2' }],
        dimension: 'data',
      },
    ],
  },
});

const cases: readonly [string, ZodType<unknown>, unknown][] = [
  [
    'Session',
    Session,
    Session.parse({
      id: 'ses-1',
      status: 'gathering',
      questionBudget: 12,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  ],
  [
    'Source',
    Source,
    Source.parse({
      id: 'src-1',
      sessionId: 'ses-1',
      kind: 'audio',
      status: 'normalized',
      derivedBy: 'transcription',
      origin: { label: 'kickoff call.m4a', mediaType: 'audio/mp4' },
      normalizedText: 'We need SSO.',
      segments: [{ text: 'We need SSO.', startMs: 0, endMs: 1500, speakerLabel: 'Client' }],
      ingestedAt: timestamp,
    }),
  ],
  ['UnderstandingRevision', UnderstandingRevision, revision],
  ['SufficiencyVerdict', SufficiencyVerdict, verdict],
  [
    'UnderstandingAssessment',
    UnderstandingAssessment,
    UnderstandingAssessment.parse({
      summary: 'partial',
      blockingItemIds: ['req-1'],
      coverage: [{ dimension: 'purpose', score: 0.9, rationale: 'clear' }],
    }),
  ],
  [
    'UnderstandingDelta',
    UnderstandingDelta,
    UnderstandingDelta.parse({
      product: { name: 'Requirely' },
      requirements: {
        add: [{ statement: 'Export to PDF', kind: 'functional', dimension: 'core-behaviour' }],
        revise: [{ id: 'req-1', priority: 'must', reason: 'confirmed' }],
        retire: [{ id: 'req-2', reason: 'contradicted' }],
      },
      decisions: {
        promote: [
          {
            from: 'req-3',
            statement: 'Export is PDF only',
            kind: 'scope',
            dimension: 'core-behaviour',
            rationale: 'DOCX was offered and not chosen.',
          },
        ],
      },
    }),
  ],
  [
    'Question',
    Question,
    Question.parse({
      id: 'qst-1',
      sessionId: 'ses-1',
      turnId: 'trn-1',
      dimension: 'users',
      about: 'req-1',
      text: 'Who can create an account?',
      mode: 'single',
      options: [
        { id: 'opt-1', label: 'Anyone' },
        { id: 'opt-2', label: 'Invited only', elaboration: 'Requires an invite flow.' },
      ],
      askedAt: timestamp,
    }),
  ],
  [
    'Answer',
    Answer,
    Answer.parse({
      id: 'ans-1',
      questionId: 'qst-1',
      selectedOptionIds: ['opt-2'],
      additionalContext: 'Admins send invites.',
      answeredAt: timestamp,
    }),
  ],
  [
    'Turn',
    Turn,
    Turn.parse({
      id: 'trn-1',
      sessionId: 'ses-1',
      index: 0,
      trigger: 'initial',
      inputSourceIds: ['src-1'],
      understandingAfter: 'rev-1',
      verdict,
      usage: [
        { provider: 'anthropic', model: 'claude-opus-5', inputTokens: 900, outputTokens: 120 },
      ],
      startedAt: timestamp,
      completedAt: timestamp,
    }),
  ],
];

describe('JSONB round-trip contract', () => {
  for (const [name, schema, value] of cases) {
    it(`${name} survives JSON serialization unchanged`, () => {
      assertRoundTrips(schema, value);
    });
  }

  it('leaves no undefined values anywhere, since JSON drops those keys silently', () => {
    const walk = (node: unknown, path: string): void => {
      if (node === undefined) throw new Error(`undefined at ${path}`);
      if (Array.isArray(node)) {
        node.forEach((item, i) => {
          walk(item, `${path}[${i}]`);
        });
      } else if (node !== null && typeof node === 'object') {
        for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`);
      }
    };

    for (const [name, , value] of cases) {
      expect(() => walk(value, name)).not.toThrow();
    }
  });

  it('keeps branded ids as plain strings on the wire', () => {
    expect(typeof z.string().parse(JSON.parse(JSON.stringify(revision)).id)).toBe('string');
  });
});
