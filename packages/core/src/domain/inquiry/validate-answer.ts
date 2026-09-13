import { InvalidAnswerError } from '../shared/errors.ts';
import type { Answer } from './answer.ts';
import type { Question } from './question.ts';

/**
 * Checks an answer against the question it claims to answer.
 *
 * These invariants cannot live in the Answer schema because they are relational
 * — every one of them needs the Question. Validating at the boundary keeps a
 * malformed answer from reaching the delta, where it would become a requirement
 * derived from an option that was never offered.
 *
 * Ordered most-specific first so the error names the real problem rather than a
 * downstream symptom.
 */
export function validateAnswer(question: Question, answer: Answer): void {
  if (answer.questionId !== question.id) {
    throw new InvalidAnswerError(
      'question-mismatch',
      `Answer ${answer.id} targets question ${answer.questionId}, not ${question.id}.`,
    );
  }

  const offered = new Set<string>(question.options.map((option) => option.id));
  const unknown = answer.selectedOptionIds.filter((id) => !offered.has(id));
  if (unknown.length > 0) {
    throw new InvalidAnswerError(
      'unknown-option',
      `Answer ${answer.id} selects option(s) not offered by ${question.id}: ${unknown.join(', ')}.`,
    );
  }

  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const id of answer.selectedOptionIds) {
    if (seen.has(id)) duplicates.push(id);
    else seen.add(id);
  }
  if (duplicates.length > 0) {
    throw new InvalidAnswerError(
      'duplicate-option',
      `Answer ${answer.id} selects the same option more than once: ${[...new Set(duplicates)].join(', ')}.`,
    );
  }

  if (question.mode === 'single' && answer.selectedOptionIds.length > 1) {
    throw new InvalidAnswerError(
      'too-many-selections',
      `Question ${question.id} accepts one selection but ${answer.selectedOptionIds.length} were given.`,
    );
  }

  const hasSelection = answer.selectedOptionIds.length > 0;
  const hasCustomText = answer.customText !== null;

  // **Only an `answered` answer has to say something.** `deferred` and
  // `delegated` are legitimately empty — that is the whole point of them, and
  // the old blanket rule is what made "I don't know" unrepresentable. Both may
  // still carry `customText` as steering, so only selections are forbidden:
  // picking an option *is* answering, and calling that a deferral would put a
  // choice in the record under a disposition that says no choice was made.
  if (answer.disposition !== 'answered') {
    if (hasSelection) {
      throw new InvalidAnswerError(
        'selection-without-answer',
        `Answer ${answer.id} is marked ${answer.disposition} but selects an option. Selecting one is answering.`,
      );
    }
    return;
  }

  if (!hasSelection && !hasCustomText) {
    throw new InvalidAnswerError(
      'empty',
      `Answer ${answer.id} selects nothing and provides no custom text. To skip it, mark it deferred; to have Requirely decide, mark it delegated.`,
    );
  }
}
