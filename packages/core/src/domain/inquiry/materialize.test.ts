import { describe, expect, it } from 'vitest';
import { fixedClock, sequentialIdGenerator } from '../testing/fakes.ts';
import { materializeQuestions, QuestionDraft } from './drafts.ts';
import { Question } from './question.ts';

/**
 * Turning a model's draft into a question the domain owns.
 *
 * The interesting part is `recommends`: the model points at a *position* in its
 * own option list, because option ids do not exist until this function mints
 * them. Every other field is a straight copy.
 */

const scope = { sessionId: 'ses-1', turnId: 'trn-1' } as never;
const ctx = () => ({ ids: sequentialIdGenerator(), clock: fixedClock('2026-01-01T00:00:00.000Z') });

const draft = (overrides: Record<string, unknown> = {}) =>
  QuestionDraft.parse({
    dimension: 'users',
    text: 'Who is this for?',
    rationale: 'Audience decides which open requirements matter.',
    mode: 'single',
    options: [
      { label: 'Product managers', means: 'Plain language over precision.' },
      { label: 'Engineers', means: 'Technical, assumes context.' },
    ],
    ...overrides,
  });

describe('materializeQuestions', () => {
  it('mints ids for the question and every option', () => {
    const [question] = materializeQuestions([draft()], scope, ctx());

    expect(question?.id).toBe('qst-1');
    expect(question?.options.map((option) => option.id)).toEqual(['opt-1', 'opt-2']);
  });

  it('translates a recommended index into the id minted for that position', () => {
    // The model cannot name an OptionId — it does not exist when the draft is
    // written. Same rule that split drafts from entities in the first place.
    const [question] = materializeQuestions(
      [draft({ recommends: 1, because: 'They will read it most closely.' })],
      scope,
      ctx(),
    );

    expect(question?.recommends).toBe('opt-2');
    expect(question?.because).toBe('They will read it most closely.');
  });

  it('carries no recommendation when the model expressed no view', () => {
    // Leaving it null is a real answer, and a better one than a coin-flip
    // dressed as advice.
    const [question] = materializeQuestions([draft()], scope, ctx());

    expect(question?.recommends).toBeNull();
    expect(question?.because).toBeNull();
  });

  it('keeps option ids unique across questions in the same turn', () => {
    // `validateAnswer` checks a selection against exactly these ids, so a
    // collision between two questions would let an answer to one validate
    // against the other.
    const questions = materializeQuestions([draft(), draft()], scope, ctx());
    const ids = questions.flatMap((question) => question.options.map((option) => option.id));

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the draft schema, which is what a model is held to', () => {
  it('rejects a recommendation pointing past the end of the options', () => {
    expect(() => draft({ recommends: 5, because: 'x' })).toThrow();
  });

  it('rejects a recommendation with no reasoning', () => {
    // A recommendation the user cannot evaluate is an instruction.
    expect(() =>
      Question.parse({
        id: 'qst-1',
        sessionId: 'ses-1',
        turnId: 'trn-1',
        dimension: 'users',
        text: 'Who?',
        rationale: 'because',
        mode: 'single',
        options: [
          { id: 'opt-1', label: 'A', means: 'x' },
          { id: 'opt-2', label: 'B', means: 'y' },
        ],
        recommends: 'opt-1',
        askedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('rejects a recommendation with no reasoning, at the draft level', () => {
    // Not just on the entity. Found live: with the rule only on `Question`, a
    // model omitting `because` produced a valid draft, so the retry decorator
    // saw a success and the failure surfaced inside `materializeQuestions` —
    // after the call was paid for, as a crash instead of one more attempt.
    expect(() => draft({ recommends: 0 })).toThrow(/must say why/);
    expect(() => draft({ recommends: 0, because: 'it is cheapest' })).not.toThrow();
    // Neither is fine: having no view is a real answer.
    expect(() => draft({ recommends: null, because: null })).not.toThrow();
  });

  it('rejects a question with no stated reason for asking', () => {
    expect(() => draft({ rationale: undefined })).toThrow();
  });

  it('rejects an option with no stated consequence', () => {
    // An option list without consequences is a menu; with them it is a decision
    // aid. That difference is the product.
    expect(() => draft({ options: [{ label: 'A' }, { label: 'B' }] })).toThrow();
  });
});
