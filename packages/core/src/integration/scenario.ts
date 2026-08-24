import type { FakeScript } from '../adapters/ai/fake.ts';
import {
  ALL_COVERAGE_DIMENSIONS,
  Answer,
  type CoverageDimension,
  type Question,
} from '../domain/index.ts';
import type { StrategyName } from '../engine/strategies.ts';

/**
 * One scripted two-turn session, shared by every integration test.
 *
 * Kept in one place so the loop test and the persistence test exercise the
 * *same* scenario — otherwise "it resumes correctly" and "it runs correctly"
 * would be claims about two different sessions.
 *
 * The fixtures reference ids like `gap-1` before they exist. That works because
 * the tests use a sequential id generator, which is itself only possible because
 * identity enters through a port.
 */

export const AT = '2026-01-01T00:00:00.000Z';

export const coverage = (
  base: number,
  overrides: Partial<Record<CoverageDimension, number>> = {},
) =>
  ALL_COVERAGE_DIMENSIONS.map((dimension) => ({
    dimension,
    score: overrides[dimension] ?? base,
    rationale: `${dimension}: scripted`,
  }));

export const TURN_1_DELTA = {
  product: { name: 'Requirely', purpose: 'Gather software requirements faster' },
  requirements: {
    add: [
      {
        statement: 'Ingest audio, text and documents into one understanding',
        kind: 'functional',
        provenance: [{ sourceId: 'src-1', quote: 'dump everything you know' }],
      },
    ],
  },
  gaps: {
    add: [
      {
        dimension: 'acceptance',
        topic: 'done criteria',
        description: 'Nothing states how anyone would know this worked.',
        blocking: false,
        impact: 'high',
      },
      {
        dimension: 'users',
        topic: 'audience',
        description: 'Who this serves is unstated.',
        blocking: false,
        impact: 'medium',
      },
    ],
  },
};

export const TURN_1_ASSESSMENT = {
  summary: 'Purpose is clear; audience and acceptance are not.',
  blockingGapIds: [],
  coverage: coverage(0.85, { acceptance: 0.2, users: 0.3 }),
};

export const TURN_1_QUESTIONS = {
  questions: [
    {
      gapId: 'gap-1',
      text: 'How would you know Requirely had worked?',
      mode: 'single',
      options: [
        { label: 'A spec an engineer can build from unaided' },
        { label: 'Fewer clarification rounds before work starts' },
      ],
    },
    {
      gapId: 'gap-2',
      text: 'Who is the primary user?',
      mode: 'multiple',
      options: [{ label: 'Product managers' }, { label: 'Engineers' }, { label: 'Founders' }],
    },
  ],
};

export const TURN_2_DELTA = {
  requirements: {
    add: [
      {
        statement: 'Produce a specification an engineer can build from unaided',
        kind: 'acceptance',
      },
    ],
  },
  gaps: {
    resolve: [
      {
        id: 'gap-1',
        resolvedByAnswerId: 'ans-1',
        resolution: 'A spec buildable without follow-up.',
      },
      { id: 'gap-2', resolvedByAnswerId: 'ans-2', resolution: 'Product managers and founders.' },
    ],
  },
};

export const TURN_2_ASSESSMENT = {
  summary: 'Everything required is now covered.',
  blockingGapIds: [],
  coverage: coverage(0.9),
};

export const SOURCE_TEXT =
  'I want a tool where you dump everything you know about a product and it asks you what is missing.';

/**
 * Per-turn slices, for tests that drive one turn at a time — a persistence test
 * that simulates two processes needs a separate generator per "process", so it
 * cannot share one script queue across both.
 */
export const TURN_1_SCRIPT: FakeScript = {
  analyze: [TURN_1_DELTA],
  assess: [TURN_1_ASSESSMENT],
  'generate-questions': [TURN_1_QUESTIONS],
};

export const TURN_2_SCRIPT: FakeScript = {
  analyze: [TURN_2_DELTA],
  assess: [TURN_2_ASSESSMENT],
};

/** The same scenario expressed for whichever strategy is under test. */
export function scriptFor(strategy: StrategyName): FakeScript {
  if (strategy === 'merged') {
    return {
      'analyze-and-assess': [
        { delta: TURN_1_DELTA, assessment: TURN_1_ASSESSMENT },
        { delta: TURN_2_DELTA, assessment: TURN_2_ASSESSMENT },
      ],
      'generate-questions': [TURN_1_QUESTIONS],
    };
  }
  return {
    analyze: [TURN_1_DELTA, TURN_2_DELTA],
    assess: [TURN_1_ASSESSMENT, TURN_2_ASSESSMENT],
    'generate-questions': [TURN_1_QUESTIONS],
  };
}

/** Answers every question by picking its first option. */
export function answerAll(questions: readonly Question[]): Answer[] {
  return questions.map((question, index) =>
    Answer.parse({
      id: `ans-${index + 1}`,
      questionId: question.id,
      selectedOptionIds: question.options[0] ? [question.options[0].id] : [],
      answeredAt: AT,
    }),
  );
}
