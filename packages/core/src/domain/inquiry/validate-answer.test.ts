import { describe, expect, it } from 'vitest';
import type { InvalidAnswerError } from '../shared/errors.ts';
import { Answer } from './answer.ts';
import { Question } from './question.ts';
import { validateAnswer } from './validate-answer.ts';

const question = (overrides: Record<string, unknown> = {}) =>
  Question.parse({
    id: 'qst-1',
    sessionId: 'ses-1',
    turnId: 'trn-1',
    dimension: 'acceptance',
    text: 'Who should be able to create an account?',
    rationale: 'Sign-up policy decides half the auth surface.',
    mode: 'single',
    options: [
      { id: 'opt-1', label: 'Anyone', means: 'Open sign-up, so abuse controls are needed.' },
      { id: 'opt-2', label: 'Invited users only', means: 'Someone has to send invites.' },
      {
        id: 'opt-3',
        label: 'Admin-created accounts',
        means: 'Growth needs an admin in the loop.',
      },
    ],
    askedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

const answer = (overrides: Record<string, unknown> = {}) =>
  Answer.parse({
    id: 'ans-1',
    questionId: 'qst-1',
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
    expect(() => question({ options: [{ id: 'opt-1', label: 'Only way' }] })).toThrow();
    expect(() => question({ options: [] })).not.toThrow();
  });
});

describe('validateAnswer', () => {
  it('accepts a single selection', () => {
    expect(() =>
      validateAnswer(question(), answer({ selectedOptionIds: ['opt-2'] })),
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
        answer({ selectedOptionIds: ['opt-1', 'opt-3'] }),
      ),
    ).not.toThrow();
  });

  it('rejects several selections on a single-choice question', () => {
    expect(
      reasonOf(() => validateAnswer(question(), answer({ selectedOptionIds: ['opt-1', 'opt-2'] }))),
    ).toBe('too-many-selections');
  });

  it('rejects an option the question never offered', () => {
    expect(
      reasonOf(() => validateAnswer(question(), answer({ selectedOptionIds: ['opt-9'] }))),
    ).toBe('unknown-option');
  });

  it('rejects the same option selected twice', () => {
    expect(
      reasonOf(() =>
        validateAnswer(
          question({ mode: 'multiple' }),
          answer({ selectedOptionIds: ['opt-1', 'opt-1'] }),
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
        validateAnswer(question(), answer({ questionId: 'qst-2', selectedOptionIds: ['opt-1'] })),
      ),
    ).toBe('question-mismatch');
  });

  it('reports the unknown option rather than the emptiness it also implies', () => {
    expect(
      reasonOf(() => validateAnswer(question(), answer({ selectedOptionIds: ['opt-9'] }))),
    ).toBe('unknown-option');
  });
});

describe('not knowing the answer', () => {
  /**
   * **"I don't know" used to be unrepresentable.** The `empty` rule rejected any
   * answer with no selection and no text, so the only legal replies were a
   * choice and a written one. That is the right model for someone who already
   * knows what they want and a bad one for almost everybody else — and it is the
   * same hole as the product's larger one, since a user saying "you decide" is
   * exactly the signal that should make Requirely infer instead of ask again.
   */
  it('lets a deferred answer be empty', () => {
    expect(() => validateAnswer(question(), answer({ disposition: 'deferred' }))).not.toThrow();
  });

  it('lets a delegated answer be empty', () => {
    expect(() => validateAnswer(question(), answer({ disposition: 'delegated' }))).not.toThrow();
  });

  it('still carries steering text on either', () => {
    // Someone who cannot answer often knows why, and "ask legal first" is real
    // information about the question even though it is not an answer to it.
    expect(() =>
      validateAnswer(
        question(),
        answer({ disposition: 'delegated', customText: 'whatever is cheapest' }),
      ),
    ).not.toThrow();
  });

  it('refuses a selection alongside either, because picking is answering', () => {
    // Otherwise the record would hold a choice under a disposition asserting no
    // choice was made, and the deliberation trail would credit the user with a
    // decision they explicitly declined to take.
    expect(
      reasonOf(() =>
        validateAnswer(
          question(),
          answer({ disposition: 'deferred', selectedOptionIds: ['opt-1'] }),
        ),
      ),
    ).toBe('selection-without-answer');
  });

  it('still requires content when the user says they answered', () => {
    expect(reasonOf(() => validateAnswer(question(), answer()))).toBe('empty');
  });

  it('points at the two ways out when an answer is empty', () => {
    // The error is the only place a caller learns these exist.
    let message = '';
    try {
      validateAnswer(question(), answer());
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('deferred');
    expect(message).toContain('delegated');
  });
});
