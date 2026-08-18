import { z } from 'zod';
import { AnswerId, RevisionId, SessionId, SourceId, TurnId } from '../shared/ids.ts';
import { Timestamp } from '../shared/time.ts';
import { Usage } from '../shared/usage.ts';
import { SufficiencyVerdict } from '../sufficiency/verdict.ts';

/** What set this iteration of the loop in motion. */
export const TurnTrigger = z.enum(['initial', 'sources-added', 'answers-received']);
export type TurnTrigger = z.infer<typeof TurnTrigger>;

/**
 * One iteration of the gathering loop, recorded in full.
 *
 * A Turn is the audit record that makes the loop debuggable: it names its
 * inputs, the revision it started from and the one it produced, the verdict it
 * reached, and what that cost. Replaying a session means walking these in order.
 */
export const Turn = z.object({
  id: TurnId,
  sessionId: SessionId,
  index: z.number().int().nonnegative(),
  trigger: TurnTrigger,
  inputSourceIds: z.array(SourceId).default([]),
  inputAnswerIds: z.array(AnswerId).default([]),
  /** Null on the first turn, where there is no prior understanding. */
  understandingBefore: RevisionId.nullable().default(null),
  understandingAfter: RevisionId,
  verdict: SufficiencyVerdict,
  /** One entry per capability call, so cost is attributable within a turn. */
  usage: z.array(Usage).default([]),
  startedAt: Timestamp,
  completedAt: Timestamp,
});
export type Turn = z.infer<typeof Turn>;
