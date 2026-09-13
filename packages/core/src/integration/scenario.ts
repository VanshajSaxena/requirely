import type { FakeScript } from '../adapters/ai/fake.ts';
import {
  ALL_COVERAGE_DIMENSIONS,
  Answer,
  type CoverageDimension,
  type Question,
} from '../domain/index.ts';
import type { StrategyName } from '../engine/strategies.ts';
import { emptyOp, emptyWireDelta, type WireDelta, type WireOp } from '../wire/index.ts';

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
 *
 * **The deltas are written in the wire format, not the domain one**, because
 * that is what a model emits. The fake generator validates every scripted value
 * against the schema the engine actually requested — which is now the codec — so
 * these fixtures exercise `decode` on every integration run rather than leaving
 * it covered only by its own unit tests.
 */

/** Builds a wire delta from partial ops, so a fixture states only what it means. */
const delta = (
  ops: readonly Partial<WireOp>[],
  product: Partial<WireDelta['product']> = {},
): WireDelta => ({
  product: { ...emptyWireDelta().product, ...product },
  ops: ops.map((op) => ({ ...emptyOp(), ...op })),
});

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

export const TURN_1_DELTA = delta(
  [
    {
      op: 'add',
      target: 'requirement',
      statement: 'Ingest audio, text and documents into one understanding',
      kind: 'functional',
      dimension: 'core-behaviour',
      provenance: [{ sourceId: 'src-1', quote: 'dump everything you know', note: '' }],
    },
    {
      op: 'add',
      target: 'requirement',
      statement: 'Produce something an engineer can act on',
      kind: 'acceptance',
      dimension: 'acceptance',
    },
    {
      op: 'add',
      target: 'constraint',
      statement: 'Serve product managers first',
      category: 'product',
      dimension: 'users',
    },
  ],
  { name: 'Requirely', purpose: 'Gather software requirements faster' },
);

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
      rationale: 'Nothing states a success condition, so nothing can be accepted against one.',
      mode: 'single',
      // A recommendation with its reasoning, so the loop test exercises the
      // anchoring-sensitive path rather than only the neutral one.
      recommends: 0,
      because: 'It measures the output rather than the process around it.',
      options: [
        {
          label: 'A spec an engineer can build from unaided',
          means: 'The bar is the document, so gathering continues until it stands alone.',
        },
        {
          label: 'Fewer clarification rounds before work starts',
          means: 'Success depends on the team around the spec, not the spec itself.',
        },
      ],
    },
    {
      dimension: 'users',
      about: 'con-1',
      text: 'Who is the primary user?',
      rationale: 'Who this serves decides which of the open requirements matter.',
      mode: 'multiple',
      options: [
        { label: 'Product managers', means: 'Wording favours plain language over precision.' },
        { label: 'Engineers', means: 'Output leans technical and assumes context.' },
        { label: 'Founders', means: 'Speed matters more than completeness.' },
      ],
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
/**
 * Turn 2 settles every required dimension, which is what sufficiency now costs.
 *
 * Under the old verdict this scenario reached `sufficient` on two promotions,
 * because a scripted assessment said coverage was 0.9 and the threshold believed
 * it. It cannot any more: sufficiency is counted, and every required dimension
 * needs a Decision behind it. Two of these come from answers and three from the
 * source — both paths, in one fixture.
 */
export const TURN_2_DELTA = delta([
  {
    op: 'promote',
    target: 'decision',
    id: 'req-2',
    statement: 'Success is a specification an engineer can build from unaided',
    kind: 'acceptance',
    dimension: 'acceptance',
    rationale:
      'Chosen over "fewer clarification rounds", which measures the process not the output.',
  },
  {
    op: 'promote',
    target: 'decision',
    id: 'con-1',
    statement: 'Product managers and founders are the primary users',
    kind: 'scope',
    dimension: 'users',
    rationale: 'Both were selected; engineers were offered and not chosen.',
  },
  {
    op: 'promote',
    target: 'decision',
    id: 'req-1',
    statement: 'Audio, text and documents all land in one understanding',
    kind: 'functional',
    dimension: 'core-behaviour',
    rationale: 'Stated directly in the brief; nothing contradicts it.',
    settledBySourceId: 'src-1',
  },
  {
    op: 'add',
    target: 'decision',
    statement: 'Requirely exists to make specifying as fast as building',
    kind: 'scope',
    dimension: 'purpose',
    rationale: 'The brief opens with it and everything else follows from it.',
    settledBySourceId: 'src-1',
  },
  {
    op: 'add',
    target: 'decision',
    statement: 'Input arrives unstructured; no format may be required of the user',
    kind: 'constraint',
    dimension: 'constraints',
    rationale: '"Dump everything you know" rules out a structured intake form.',
    settledBySourceId: 'src-1',
  },
]);

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

/**
 * Answers every question by picking its first option.
 *
 * **`turn` is not decoration.** Answer ids are fixture-minted, so a session that
 * runs three turns mints `ans-1` three times and the second commit fails on a
 * primary-key conflict. Production never has this problem — ids come from
 * `IdGenerator` — but a fixture that quietly collided would make a multi-turn
 * test impossible to write and the reason hard to see.
 */
export function answerAll(questions: readonly Question[], turn = 1): Answer[] {
  return questions.map((question, index) =>
    Answer.parse({
      id: `ans-${turn}-${index + 1}`,
      questionId: question.id,
      selectedOptionIds: question.options[0] ? [question.options[0].id] : [],
      answeredAt: AT,
    }),
  );
}
