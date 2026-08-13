import { describe, expect, it } from 'vitest';
import type { InvalidAnswerError } from '../shared/errors.ts';
import { Answer } from './answer.ts';
import { Question } from './question.ts';
import { validateAnswer } from './validate-answer.ts';

const question = (overrides: Record<string, unknown> = {}) =>
  Question.parse({
    id: 'qst_1',
    sessionId: 'ses_1',
    turnId: 'trn_1',
    gapId: 'gap_1',
    text: 'Who should be able to create an account?',
    mode: 'single',
    options: [
      { id: 'opt_1', label: 'Anyone' },
      { id: 'opt_2', label: 'Invited users only' },
      { id: 'opt_3', label: 'Admin-created accounts' },
    ],
    askedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

const answer = (overrides: Record<string, unknown> = {}) =>
  Answer.parse({
    id: 'ans_1',
    questionId: 'qst_1',
    answeredAt: '2026-01-01T00:01:00.000Z',
    ...overrides,
  });

const reasonOf = (fn: () => void): string => {
  try {
    fn();
  } catch (error) {
    return (error as InvalidAnswerError).reason;
  }
  throw new Error('expected validateAnswer to throw');
};

describe('Question schema', () => {
  it('always permits a custom answer', () => {
    expect(question().allowsCustom).toBe(true);
    // The invariant is in the type, so a question forbidding custom text is unconstructable.
    expect(() => Question.parse({ ...question(), allowsCustom: false })).toThrow();
  });

  it('rejects exactly one option, since that is a leading question rather than a choice', () => {
    expect(() => question({ options: [{ id: 'opt_1', label: 'Only way' }] })).toThrow();
    expect(() => question({ options: [] })).not.toThrow();
  });
});

describe('validateAnswer', () => {
  it('accepts a single selection', () => {
    expect(() =>
      validateAnswer(question(), answer({ selectedOptionIds: ['opt_2'] })),
    ).not.toThrow();
  });

  it('accepts a custom answer with no selection', () => {
    expect(() =>
      validateAnswer(question(), answer({ customText: 'Only users from an allow-listed domain.' })),
    ).not.toThrow();
  });

  it('accepts multiple selections when the question allows them', () => {
    expect(() =>
      validateAnswer(
        question({ mode: 'multiple' }),
        answer({ selectedOptionIds: ['opt_1', 'opt_3'] }),
      ),
    ).not.toThrow();
  });

  it('rejects several selections on a single-choice question', () => {
    expect(
      reasonOf(() => validateAnswer(question(), answer({ selectedOptionIds: ['opt_1', 'opt_2'] }))),
    ).toBe('too-many-selections');
  });

  it('rejects an option the question never offered', () => {
    expect(
      reasonOf(() => validateAnswer(question(), answer({ selectedOptionIds: ['opt_9'] }))),
    ).toBe('unknown-option');
  });

  it('rejects the same option selected twice', () => {
    expect(
      reasonOf(() =>
        validateAnswer(
          question({ mode: 'multiple' }),
          answer({ selectedOptionIds: ['opt_1', 'opt_1'] }),
        ),
      ),
    ).toBe('duplicate-option');
  });

  it('rejects an answer that neither selects nor says anything', () => {
    expect(reasonOf(() => validateAnswer(question(), answer()))).toBe('empty');
  });

  it('rejects an answer aimed at a different question', () => {
    expect(
      reasonOf(() =>
        validateAnswer(question(), answer({ questionId: 'qst_2', selectedOptionIds: ['opt_1'] })),
      ),
    ).toBe('question-mismatch');
  });

  it('reports the unknown option rather than the emptiness it also implies', () => {
    expect(
      reasonOf(() => validateAnswer(question(), answer({ selectedOptionIds: ['opt_9'] }))),
    ).toBe('unknown-option');
  });
});
