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
 * The fixtures reference ids like `req-1` before they exist. That works because
 * `applyDelta` mints from the document's own counters, so the first requirement
 * added on turn 1 is always `req-1` — no id generator involved.
 *
 * **The scenario's shape is the redesign in miniature.** Turn 1 proposes open
 * items and asks about them; turn 2 promotes them to decisions using answers.
 * A scenario that only ever added things would pass every test while never
 * exercising the one transition the product exists to make.
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
        dimension: 'core-behaviour',
        provenance: [{ sourceId: 'src-1', quote: 'dump everything you know' }],
      },
      {
        statement: 'Produce something an engineer can act on',
        kind: 'acceptance',
        dimension: 'acceptance',
      },
    ],
  },
  constraints: {
    add: [{ statement: 'Serve product managers first', category: 'product', dimension: 'users' }],
  },
};

export const TURN_1_ASSESSMENT = {
  summary: 'Purpose is clear; audience and acceptance are not.',
  blockingItemIds: [],
  coverage: coverage(0.85, { acceptance: 0.2, users: 0.3 }),
};

export const TURN_1_QUESTIONS = {
  questions: [
    {
      dimension: 'acceptance',
      about: 'req-2',
      text: 'How would you know Requirely had worked?',
      mode: 'single',
      options: [
        { label: 'A spec an engineer can build from unaided' },
        { label: 'Fewer clarification rounds before work starts' },
      ],
    },
    {
      dimension: 'users',
      about: 'con-1',
      text: 'Who is the primary user?',
      mode: 'multiple',
      options: [{ label: 'Product managers' }, { label: 'Engineers' }, { label: 'Founders' }],
    },
  ],
};

/**
 * Both answered items are promoted, which is what makes turn 2 a *settling* turn.
 *
 * Neither promotion sets `settledBySourceId`: the engine derives the answer from
 * `Question.about`, so a fixture that spelled out an `AnswerId` would be testing
 * a path production never takes.
 */
export const TURN_2_DELTA = {
  decisions: {
    promote: [
      {
        from: 'req-2',
        statement: 'Success is a specification an engineer can build from unaided',
        kind: 'acceptance',
        dimension: 'acceptance',
        rationale:
          'Chosen over "fewer clarification rounds", which measures the process not the output.',
      },
      {
        from: 'con-1',
        statement: 'Product managers and founders are the primary users',
        kind: 'scope',
        dimension: 'users',
        rationale: 'Both were selected; engineers were offered and not chosen.',
      },
    ],
  },
};

export const TURN_2_ASSESSMENT = {
  summary: 'Everything required is now covered.',
  blockingItemIds: [],
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
