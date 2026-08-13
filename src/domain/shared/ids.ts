import { z } from 'zod';

/**
 * Branded identifiers.
 *
 * The domain cross-references heavily — a Gap is answered by an Answer, which
 * belongs to a Question, which was raised by a Turn. Plain `string` makes every
 * one of those a silent swap waiting to happen, so each ID carries a brand that
 * only its own schema can produce.
 *
 * Construct with `RequirementId.parse(raw)`. That is deliberate friction: it is
 * the single point where an untrusted string becomes a trusted identifier.
 */

const brandedId = <B extends string>() => z.string().min(1).brand<B>();

export const SessionId = brandedId<'SessionId'>();
export type SessionId = z.infer<typeof SessionId>;

export const SourceId = brandedId<'SourceId'>();
export type SourceId = z.infer<typeof SourceId>;

export const RevisionId = brandedId<'RevisionId'>();
export type RevisionId = z.infer<typeof RevisionId>;

export const TurnId = brandedId<'TurnId'>();
export type TurnId = z.infer<typeof TurnId>;

export const QuestionId = brandedId<'QuestionId'>();
export type QuestionId = z.infer<typeof QuestionId>;

export const OptionId = brandedId<'OptionId'>();
export type OptionId = z.infer<typeof OptionId>;

export const AnswerId = brandedId<'AnswerId'>();
export type AnswerId = z.infer<typeof AnswerId>;

export const RequirementId = brandedId<'RequirementId'>();
export type RequirementId = z.infer<typeof RequirementId>;

export const ConstraintId = brandedId<'ConstraintId'>();
export type ConstraintId = z.infer<typeof ConstraintId>;

export const AssumptionId = brandedId<'AssumptionId'>();
export type AssumptionId = z.infer<typeof AssumptionId>;

export const ContradictionId = brandedId<'ContradictionId'>();
export type ContradictionId = z.infer<typeof ContradictionId>;

export const GapId = brandedId<'GapId'>();
export type GapId = z.infer<typeof GapId>;

/**
 * Prefixes make an ID self-describing in logs and in a model's context window —
 * `req_01J...` is legible where a bare UUID is not.
 */
export const ID_PREFIX = {
  session: 'ses',
  source: 'src',
  revision: 'rev',
  turn: 'trn',
  question: 'qst',
  option: 'opt',
  answer: 'ans',
  requirement: 'req',
  constraint: 'con',
  assumption: 'asm',
  contradiction: 'ctr',
  gap: 'gap',
} as const;

export type EntityKind = keyof typeof ID_PREFIX;
