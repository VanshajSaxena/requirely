import { z } from 'zod';

/**
 * Branded identifiers.
 *
 * The domain cross-references heavily — a Decision is settled by an Answer, which
 * belongs to a Question, which was raised by a Turn. Plain `string` makes every
 * one of those a silent swap waiting to happen, so each ID carries a brand that
 * only its own schema can produce.
 *
 * Construct with `RequirementId.parse(raw)`. That is deliberate friction: it is
 * the single point where an untrusted string becomes a trusted identifier.
 */

const brandedId = <B extends string>() => z.string().min(1).brand<B>();

/**
 * The four uncertain collections share a supertype, and the brands express it.
 *
 * Zod brands **intersect** rather than replace, so `.brand<'OpenItem'>().brand<'RequirementId'>()`
 * yields `string & $brand<'OpenItem'> & $brand<'RequirementId'>`. That is assignable
 * to `OpenItemId` — while `OpenItemId` is assignable to none of the four, and no
 * two of the four are assignable to each other. So `Decision.promotedFrom` can
 * accept any of them with no cast, and still nothing can be silently swapped.
 *
 * Verified in all three directions with `@ts-expect-error` before adoption; do not
 * "simplify" this to a plain `z.string()` union, which loses the narrowing half.
 */
const openItemId = <B extends string>() => z.string().min(1).brand<'OpenItem'>().brand<B>();

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

export const DecisionId = brandedId<'DecisionId'>();
export type DecisionId = z.infer<typeof DecisionId>;

export const RequirementId = openItemId<'RequirementId'>();
export type RequirementId = z.infer<typeof RequirementId>;

export const ConstraintId = openItemId<'ConstraintId'>();
export type ConstraintId = z.infer<typeof ConstraintId>;

export const AssumptionId = openItemId<'AssumptionId'>();
export type AssumptionId = z.infer<typeof AssumptionId>;

export const ContradictionId = openItemId<'ContradictionId'>();
export type ContradictionId = z.infer<typeof ContradictionId>;

/**
 * What settled a Decision: an Answer the user gave, or a Source that stated it.
 *
 * The union's runtime check is just "non-empty string" — brands are type-only —
 * but the *type* is the union, which is what stops a `QuestionId` landing here.
 *
 * Only the Source half is ever model-emitted. `AnswerId` is a 40-character
 * UUIDv7, and asking a model to transcribe one is exactly the failure Phase 3b
 * removed, so the engine derives answer-settled promotions from `Question.about`
 * and the model's slot on the wire accepts a `src-N` alone.
 */
export const SettledBy = z.union([AnswerId, SourceId]);
export type SettledBy = z.infer<typeof SettledBy>;

/** Prefixes an id must carry to name something in the uncertain tier. */
export const OPEN_ITEM_PREFIXES = ['req', 'con', 'asm', 'ctr'] as const;

/**
 * Any id in the uncertain tier: requirement, constraint, assumption, contradiction.
 *
 * Parsing checks the prefix, which is the only structural fact shared by all four.
 * A value that *already* has one of the four brands widens here without parsing.
 */
export const OpenItemId = z
  .string()
  .min(1)
  .refine((value) => OPEN_ITEM_PREFIXES.some((prefix) => value.startsWith(`${prefix}-`)), {
    message: `An open-item id must start with one of: ${OPEN_ITEM_PREFIXES.join(', ')}`,
  })
  .brand<'OpenItem'>();
export type OpenItemId = z.infer<typeof OpenItemId>;

/**
 * Prefixes make an ID self-describing in logs and in a model's context window —
 * `req-1` is legible where a bare UUID is not.
 */
export const ID_PREFIX = {
  session: 'ses',
  source: 'src',
  revision: 'rev',
  turn: 'trn',
  question: 'qst',
  option: 'opt',
  answer: 'ans',
  decision: 'dec',
  requirement: 'req',
  constraint: 'con',
  assumption: 'asm',
  contradiction: 'ctr',
} as const;

export type EntityKind = keyof typeof ID_PREFIX;
