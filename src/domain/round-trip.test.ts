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
  blockingGapIds: ['gap_1'],
  questionsAsked: 2,
  questionBudget: 12,
  budgetExhausted: false,
});

const revision = UnderstandingRevision.parse({
  id: 'rev_1',
  sessionId: 'ses_1',
  revision: 1,
  producedByTurnId: 'trn_1',
  createdAt: timestamp,
  content: {
    product: { name: 'Requirely', users: [{ label: 'Product managers', needs: ['faster specs'] }] },
    requirements: [
      {
        id: 'req_1',
        statement: 'Users sign in via SSO',
        kind: 'functional',
        confidence: 0.8,
        provenance: [{ sourceId: 'src_1', quote: 'we use Okta' }],
      },
    ],
    constraints: [{ id: 'con_1', statement: 'Must run on-premise', category: 'technical' }],
    assumptions: [
      {
        id: 'asm_1',
        statement: 'English only at launch',
        basis: 'no locale mentioned',
        risk: 'low',
      },
    ],
    contradictions: [
      {
        id: 'ctr_1',
        description: 'Retention stated as both 30 and 90 days',
        between: [{ sourceId: 'src_1' }, { sourceId: 'src_2' }],
      },
    ],
    gaps: [
      {
        id: 'gap_1',
        dimension: 'acceptance',
        topic: 'sign-out',
        description: 'unknown',
        blocking: true,
        impact: 'high',
      },
    ],
    resolvedGaps: [
      {
        id: 'gap_0',
        dimension: 'purpose',
        topic: 'audience',
        description: 'unknown',
        blocking: false,
        impact: 'low',
        resolvedByAnswerId: 'ans_1',
        resolution: 'Internal teams first.',
      },
    ],
  },
});

const cases: readonly [string, ZodType<unknown>, unknown][] = [
  [
    'Session',
    Session,
    Session.parse({
      id: 'ses_1',
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
      id: 'src_1',
      sessionId: 'ses_1',
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
      blockingGapIds: ['gap_1'],
      coverage: [{ dimension: 'purpose', score: 0.9, rationale: 'clear' }],
    }),
  ],
  [
    'UnderstandingDelta',
    UnderstandingDelta,
    UnderstandingDelta.parse({
      product: { name: 'Requirely' },
      requirements: {
        add: [{ statement: 'Export to PDF', kind: 'functional', confidence: 0.5 }],
        revise: [{ id: 'req_1', confidence: 0.95, reason: 'confirmed' }],
        remove: [{ id: 'req_2', reason: 'contradicted' }],
      },
      gaps: { resolve: [{ id: 'gap_1', resolvedByAnswerId: 'ans_1', resolution: 'answered' }] },
    }),
  ],
  [
    'Question',
    Question,
    Question.parse({
      id: 'qst_1',
      sessionId: 'ses_1',
      turnId: 'trn_1',
      gapId: 'gap_1',
      text: 'Who can create an account?',
      mode: 'single',
      options: [
        { id: 'opt_1', label: 'Anyone' },
        { id: 'opt_2', label: 'Invited only', elaboration: 'Requires an invite flow.' },
      ],
      askedAt: timestamp,
    }),
  ],
  [
    'Answer',
    Answer,
    Answer.parse({
      id: 'ans_1',
      questionId: 'qst_1',
      selectedOptionIds: ['opt_2'],
      additionalContext: 'Admins send invites.',
      answeredAt: timestamp,
    }),
  ],
  [
    'Turn',
    Turn,
    Turn.parse({
      id: 'trn_1',
      sessionId: 'ses_1',
      index: 0,
      trigger: 'initial',
      inputSourceIds: ['src_1'],
      understandingAfter: 'rev_1',
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
