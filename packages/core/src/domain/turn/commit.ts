import { z } from 'zod';
import { Answer } from '../inquiry/answer.ts';
import { Question } from '../inquiry/question.ts';
import { Session } from '../session/session.ts';
import { UnderstandingRevision } from '../understanding/understanding.ts';
import { Turn } from './turn.ts';

/**
 * Everything one turn changed, as a single command.
 *
 * The engine produces this instead of writing as it goes. Two things follow:
 *
 * 1. **Nothing is durable until the turn fully succeeds.** Previously the loop
 *    wrote answers, then made three model calls, then wrote the rest — so a
 *    failed call left orphaned answers with no turn referencing them.
 * 2. **The database transaction lasts milliseconds, not model-call seconds.**
 *    Wrapping the whole loop in a transaction instead would hold a connection
 *    and its row locks open for the entire duration of the LLM calls.
 *
 * The cross-field checks below make the command self-consistent by construction.
 * They catch an engine bug at the boundary rather than letting a half-coherent
 * turn reach storage, where it becomes a data problem instead of a crash.
 */
export const TurnCommit = z
  .object({
    session: Session,
    revision: UnderstandingRevision,
    turn: Turn,
    questions: z.array(Question).default([]),
    answers: z.array(Answer).default([]),
  })
  .superRefine((commit, ctx) => {
    const fail = (message: string, path: (string | number)[]) => {
      ctx.addIssue({ code: 'custom', message, path });
    };

    if (commit.revision.sessionId !== commit.session.id) {
      fail('revision belongs to a different session', ['revision', 'sessionId']);
    }
    if (commit.turn.sessionId !== commit.session.id) {
      fail('turn belongs to a different session', ['turn', 'sessionId']);
    }

    // The turn and the revision it produced must point at each other, or replay
    // cannot reconstruct which turn caused which change.
    if (commit.turn.understandingAfter !== commit.revision.id) {
      fail('turn does not point at the revision it produced', ['turn', 'understandingAfter']);
    }
    if (commit.revision.producedByTurnId !== commit.turn.id) {
      fail('revision does not credit the turn that produced it', ['revision', 'producedByTurnId']);
    }

    // Each turn appends exactly one revision, so these two sequences are the
    // same sequence. Keeping them equal removes a way for them to disagree.
    if (commit.turn.index !== commit.revision.revision) {
      fail('turn index and revision number must match', ['turn', 'index']);
    }

    if (commit.session.currentRevisionId !== commit.revision.id) {
      fail('session does not point at the new revision', ['session', 'currentRevisionId']);
    }

    commit.questions.forEach((question, index) => {
      if (question.sessionId !== commit.session.id) {
        fail('question belongs to a different session', ['questions', index, 'sessionId']);
      }
      if (question.turnId !== commit.turn.id) {
        fail('question was not raised by this turn', ['questions', index, 'turnId']);
      }
    });

    const answerIds = new Set(commit.answers.map((answer) => answer.id as string));
    for (const id of commit.turn.inputAnswerIds) {
      if (!answerIds.has(id)) {
        fail(`turn cites answer ${id}, which is not in the commit`, ['turn', 'inputAnswerIds']);
      }
    }
  });
export type TurnCommit = z.infer<typeof TurnCommit>;
