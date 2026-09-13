import { z } from 'zod';
import type { Clock } from '../ports/clock.ts';
import type { IdGenerator } from '../ports/id-generator.ts';
import { SessionStateError } from '../shared/errors.ts';
import { RevisionId, SessionId } from '../shared/ids.ts';
import { Timestamp } from '../shared/time.ts';
import { Temperament } from '../temperament/temperament.ts';

/**
 * The output target is nullable by design. A user may declare it up front
 * ("write an SRS") or decide after dumping context, so ingestion and analysis
 * must work without knowing it.
 */
export const OutputTarget = z.enum(['srs', 'requirements-doc', 'agent-prompt']);
export type OutputTarget = z.infer<typeof OutputTarget>;

/**
 * Three ways a session can stop, and they mean different things.
 *
 * - **`sufficient`** — enough is settled to describe what to build.
 * - **`exhausted`** — the question budget ran out first. *"We were still making
 *   progress and ran out of room."*
 * - **`stalled`** — turns are passing and nothing new is getting settled. *"There
 *   is room left and spending it is not helping."*
 *
 * None is a failure, and all three finalize: projections then render what is
 * still open, which is more honest than a confident document hiding its holes.
 * Collapsing `stalled` into `exhausted` would lose the only distinction a user
 * can act on — one says "give me a bigger budget", the other says "the questions
 * are not landing, give me better input".
 */
export const SessionStatus = z.enum([
  'gathering',
  'awaiting-answers',
  'sufficient',
  'exhausted',
  'stalled',
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
  /**
   * How Requirely should work on this session.
   *
   * On the Session rather than in config because it is a property of *this piece
   * of work*, not of the installation: the same person running two sessions wants
   * different dials for a half-formed idea and for a spec they already wrote.
   *
   * `prefault` rather than `default`: every dial has its own default, and
   * `.default({})` would short-circuit parsing and hand back a literal `{}`.
   */
  temperament: Temperament.prefault({}),
  currentRevisionId: RevisionId.nullable().default(null),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Session = z.infer<typeof Session>;

/**
 * Any of these four is a legitimate outcome of running a turn, from any state —
 * including a finalized session the user reopened by adding a new document.
 */
const TURN_OUTCOMES = [
  'gathering',
  'awaiting-answers',
  'sufficient',
  'exhausted',
  'stalled',
] as const;

/**
 * There is really only one rule here: **you cannot finalize what you have not
 * assessed.** `finalized` is reachable only from `sufficient` or `exhausted`,
 * because both of those carry a recorded verdict explaining the state of the
 * understanding — and a generated document with no verdict behind it is exactly
 * the "confident output hiding its holes" this design exists to prevent.
 *
 * Everything else is permitted, so this table is deliberately permissive rather
 * than ceremonial. An earlier version forbade `awaiting-answers → sufficient`,
 * which is the single most common transition in the entire loop.
 */
const LEGAL_TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  gathering: TURN_OUTCOMES,
  'awaiting-answers': TURN_OUTCOMES,
  sufficient: [...TURN_OUTCOMES, 'finalized'],
  exhausted: [...TURN_OUTCOMES, 'finalized'],
  // Finalizable for the same reason `exhausted` is: a stalled session carries a
  // recorded verdict explaining why it stopped, which is the one thing
  // `finalized` actually requires.
  stalled: [...TURN_OUTCOMES, 'finalized'],
  finalized: TURN_OUTCOMES,
};

export interface CreateSessionInput {
  readonly questionBudget: number;
  readonly title?: string | undefined;
  readonly outputTarget?: OutputTarget | undefined;
  /** Omitted means neutral on every dial — see `BALANCED_TEMPERAMENT`. */
  readonly temperament?: Temperament | undefined;
}

/**
 * A new session starts in `gathering` with no revision and nothing asked.
 *
 * `outputTarget` is optional here on purpose — the spec allows the user to
 * declare it up front or decide after dumping context, and nothing in ingestion
 * or analysis may depend on knowing it.
 */
export function createSession(
  input: CreateSessionInput,
  ctx: { readonly ids: IdGenerator; readonly clock: Clock },
): Session {
  const now = ctx.clock.now();
  return Session.parse({
    id: SessionId.parse(ctx.ids.next('session')),
    title: input.title ?? null,
    status: 'gathering',
    outputTarget: input.outputTarget ?? null,
    questionBudget: input.questionBudget,
    questionsAsked: 0,
    temperament: input.temperament ?? {},
    currentRevisionId: null,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Marks a session finished and records what was generated from it.
 *
 * A separate, explicit act — projections are pure and mutate nothing, so
 * rendering a document does not by itself finish a session. `assertTransition`
 * keeps `finalized` reachable only from `sufficient` or `exhausted`, which is
 * the one rule that state machine exists to enforce: **you cannot finalize what
 * you have not assessed.** Both of those states carry a recorded verdict; a
 * document generated without one would be exactly the confident output hiding
 * its holes that this design exists to prevent.
 */
export function finalizeSession(
  session: Session,
  target: OutputTarget,
  ctx: { readonly clock: Clock },
): Session {
  assertTransition(session.status, 'finalized');
  return Session.parse({
    ...session,
    status: 'finalized',
    outputTarget: target,
    updatedAt: ctx.clock.now(),
  });
}

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!canTransition(from, to)) throw new SessionStateError(from, to);
}

export function budgetRemaining(session: Session): number {
  return Math.max(0, session.questionBudget - session.questionsAsked);
}
