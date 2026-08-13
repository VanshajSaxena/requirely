import { z } from 'zod';
import { SessionStateError } from '../shared/errors.ts';
import { RevisionId, SessionId } from '../shared/ids.ts';
import { Timestamp } from '../shared/time.ts';

/**
 * The output target is nullable by design. A user may declare it up front
 * ("write an SRS") or decide after dumping context, so ingestion and analysis
 * must work without knowing it.
 */
export const OutputTarget = z.enum(['srs', 'requirements-doc', 'agent-prompt']);
export type OutputTarget = z.infer<typeof OutputTarget>;

/**
 * `exhausted` is a first-class state, not a failure: the question budget ran out
 * before sufficiency was reached. The session can still finalize — projections
 * then render an explicit "known gaps and assumptions" section — which is more
 * honest than a confident document that hides its holes.
 */
export const SessionStatus = z.enum([
  'gathering',
  'awaiting-answers',
  'sufficient',
  'exhausted',
  'finalized',
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const Session = z.object({
  id: SessionId,
  title: z.string().min(1).nullable().default(null),
  status: SessionStatus,
  outputTarget: OutputTarget.nullable().default(null),
  questionBudget: z.number().int().positive(),
  questionsAsked: z.number().int().nonnegative().default(0),
  currentRevisionId: RevisionId.nullable().default(null),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Session = z.infer<typeof Session>;

/**
 * Every terminal state can return to `gathering`: a user who adds a new document
 * to a finalized session is starting the loop again, not corrupting it.
 */
const LEGAL_TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  gathering: ['awaiting-answers', 'sufficient', 'exhausted'],
  'awaiting-answers': ['gathering', 'exhausted'],
  sufficient: ['finalized', 'gathering'],
  exhausted: ['finalized', 'gathering'],
  finalized: ['gathering'],
};

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!canTransition(from, to)) throw new SessionStateError(from, to);
}

export function budgetRemaining(session: Session): number {
  return Math.max(0, session.questionBudget - session.questionsAsked);
}
