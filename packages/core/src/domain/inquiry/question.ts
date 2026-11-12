import { z } from 'zod';
import { OpenItemId, OptionId, QuestionId, SessionId, TurnId } from '../shared/ids.ts';
import { Timestamp } from '../shared/time.ts';
import { CoverageDimension } from '../sufficiency/coverage.ts';

/** Some questions admit exactly one answer, others several. Both are required by the spec. */
export const AnswerMode = z.enum(['single', 'multiple']);
export type AnswerMode = z.infer<typeof AnswerMode>;

export const QuestionOption = z.object({
  id: OptionId,
  label: z.string().min(1),
  /**
   * What this option actually means, in one plain sentence.
   *
   * Required, and that is the point. An option list without explanations is a
   * menu; with them it is a decision aid. "Magic links" and "magic links — a
   * sign-in link is emailed each time, so there is no password to store, but
   * every sign-in needs a working inbox" are the same choice offered to two very
   * different people.
   *
   * **Renamed from `commits`, and the rename is the change.** The old name — and
   * the CLI label "commits you to:" that sat above it — read as an obligation
   * being incurred, which is exactly wrong for a user who does not yet know what
   * they want. Nothing here is binding: a Decision can be superseded, and that is
   * what `Decision.supersededBy` is for. The field's job is to let someone
   * *recognise* the right answer rather than having to recall it, which is the
   * whole reason options exist.
   *
   * So it should say what the option is, when it fits, and what it costs —
   * whichever of those a reader needs. One field rather than three: three
   * required strings across four options is twelve per question, and each one
   * gets thinner as the model divides its attention.
   *
   * This is also what QOC's *Criteria* would have provided. Criteria are the part
   * of QOC that most obviously adds capture burden, and burden is the documented
   * reason IBIS and QOC were not adopted — so options are compared by what each
   * one means rather than against a shared reusable axis.
   *
   * A sibling `elaboration` field lived here and was deleted: it was nullable, set
   * by two test fixtures, rendered by nothing, and named in no prompt — so no
   * model ever filled it. It cost a union slot against the grammar caps for
   * nothing. A field no prompt mentions is a field that does not exist.
   */
  means: z.string().min(1),
  /**
   * Open items this option would settle, if chosen.
   *
   * Read by the engine: when an answer selects an option, every id here joins the
   * `settledBy` map alongside `Question.about`. That lets one question settle
   * different items depending on the answer — "which of these do you actually
   * need?" closes whichever ones were picked, and only those.
   */
  settles: z.array(OpenItemId).default([]),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

/**
 * Zero options means a genuinely open question; two or more offer the low-effort
 * path. Exactly one is rejected: a single option is not a choice, it is a
 * leading question.
 *
 * Factored out so the entity and the draft enforce the same rule from one
 * definition — the draft is what a model emits, and it is precisely there that
 * the rule needs to hold.
 */
export const optionListRule = <T extends z.ZodType>(option: T) =>
  z
    .array(option)
    .refine((options) => options.length !== 1, {
      message: 'A question must offer either no options or at least two.',
    })
    .default([]);

/**
 * The fields, without the cross-field rules.
 *
 * **Split from `Question` because of a Zod trap that no typechecker sees.**
 * `.refine()` in Zod 4 attaches a check to the same `ZodObject` rather than
 * wrapping it, so `Question.omit(...)` still *compiles* — and then throws at
 * module load with *".omit() cannot be used on object schemas containing
 * refinements"*. `tsc` is green, `pnpm test` dies on import.
 *
 * Drafts derive from this; the refined `Question` below is what anything
 * parsing a real question uses. Keep any new cross-field rule on `Question`
 * alone: a draft names its recommendation by *index*, so the "must name one of
 * this question's options" rule is meaningless there and would reject every
 * valid draft.
 */
export const QuestionShape = z.object({
  id: QuestionId,
  sessionId: SessionId,
  turnId: TurnId,
  /**
   * Which part of the coverage picture this question serves.
   *
   * Replaces `gapId`, and the change is not a rename. A question used to require
   * a `Gap` entity to point at, which meant the model had to invent a gap before
   * it could ask about an absence. A dimension is always available, so "nobody
   * has said how success is measured" needs no placeholder entity — and question
   * ordering already ran off `verdict.shortfalls`, which is dimension-shaped.
   */
  dimension: CoverageDimension,
  /**
   * The specific open item this question would settle, when there is one.
   *
   * Null for a question about an absence. When non-null and the question is
   * answered, the engine derives `Decision.settledBy` from it — which is what
   * keeps a 40-character `AnswerId` off the wire.
   */
  about: OpenItemId.nullable().default(null),
  text: z.string().min(1),
  mode: AnswerMode,
  options: optionListRule(QuestionOption),
  /**
   * Always true, encoded in the type. The highest-flexibility path is a product
   * invariant, so it must not be possible to construct a question that forbids
   * a custom answer.
   */
  allowsCustom: z.literal(true).default(true),
  /**
   * Why this is being asked, in the asker's own words.
   *
   * **Required, where it used to be nullable.** Requirely is not a
   * question-asking machine: a question with no stated reason is a form field,
   * and the product's claim is that it has already thought the problem through
   * and is checking its reasoning. Making this optional made it the first thing
   * a model would drop under output pressure.
   */
  rationale: z.string().min(1),
  /**
   * The option Requirely would choose, if it had to.
   *
   * **A separate field precisely so a UI can withhold it.** Pre-selecting an
   * option anchors: a pre-selected default is a textbook anchor. Keeping the
   * recommendation out of the option list means a surface can show the choice
   * first and the opinion second, or not at all — and the eval
   * suite tracks acceptance rate, because a suspiciously high one is the signal
   * that Requirely stopped offering a choice and started making it.
   *
   * Never a penalty: choosing something else is an ordinary answer, and nothing
   * in the domain treats it differently.
   */
  recommends: OptionId.nullable().default(null),
  /** Why that recommendation. Present exactly when `recommends` is. */
  because: z.string().min(1).nullable().default(null),
  askedAt: Timestamp,
});

export const Question = QuestionShape.refine(
  (question) => question.recommends === null || question.because !== null,
  {
    message: 'A recommendation must say why. Set `because` alongside `recommends`.',
    path: ['because'],
  },
).refine(
  (question) =>
    question.recommends === null ||
    question.options.some((option) => option.id === question.recommends),
  {
    message: "A recommendation must name one of this question's own options.",
    path: ['recommends'],
  },
);
export type Question = z.infer<typeof Question>;
