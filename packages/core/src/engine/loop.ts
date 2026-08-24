import {
  type Answer,
  type AnswerId,
  applyDelta,
  assertTransition,
  CapabilityError,
  type Clock,
  decideSufficiency,
  emptyUnderstanding,
  type GapId,
  type IdGenerator,
  type InquiryRepository,
  materializeQuestions,
  type Question,
  type QuestionDraft,
  RevisionId,
  type Session,
  type SessionId,
  type SessionRepository,
  type Source,
  type SourceId,
  type SourceRepository,
  type SufficiencyPolicy,
  type SufficiencyVerdict,
  type Turn,
  TurnCommit,
  TurnId,
  type TurnTrigger,
  type Understanding,
  type UnderstandingAssessment,
  type UnderstandingRepository,
  UnderstandingRevision,
  validateAnswer,
} from '../domain/index.ts';
import type { AnsweredQuestion } from './context.ts';
import type { StepDeps } from './steps.ts';
import { generateQuestions } from './steps.ts';
import type { AnalysisStrategy, Merge } from './strategies.ts';

export interface EngineDeps extends StepDeps {
  readonly sessions: SessionRepository;
  readonly sources: SourceRepository;
  readonly revisions: UnderstandingRepository;
  readonly inquiry: InquiryRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly policy: SufficiencyPolicy;
  readonly strategy: AnalysisStrategy;
  readonly maxQuestionsPerTurn: number;
}

export interface TurnRequest {
  readonly trigger: TurnTrigger;
  readonly sourceIds?: readonly SourceId[];
  readonly answers?: readonly Answer[];
}

// `runTurn` returns a TurnCommit rather than a bespoke result type: what the
// caller wants to inspect and what needs persisting are the same thing.

/**
 * Reconciles the model's opinion about blocking gaps with what actually exists.
 *
 * Two sources of truth get unioned: gaps the analysis flagged `blocking`, and
 * gaps the assessment named. IDs that match no open gap are **dropped, not
 * thrown** — unlike a delta, where a bad ID must fail the turn. The asymmetry is
 * deliberate: a hallucinated blocking gap that survived would veto sufficiency
 * on every future turn, deadlocking the session permanently. A delta failing
 * loudly costs one retry; this failing loudly costs the whole session.
 */
export function resolveBlockingGaps(
  understanding: Understanding,
  assessment: UnderstandingAssessment,
): GapId[] {
  const open = new Map(understanding.gaps.map((gap) => [gap.id as string, gap]));
  const flagged = understanding.gaps.filter((gap) => gap.blocking).map((gap) => gap.id);
  const claimed = assessment.blockingGapIds.filter((id) => open.has(id));
  return [...new Set([...flagged, ...claimed])];
}

/**
 * Chooses which drafted questions to actually ask.
 *
 * Ordering comes from the domain's own computed shortfall order, not from a
 * priority number the model invents — the same reason `Requirement.confidence`
 * was removed. Drafts targeting a gap that is not open are dropped, because a
 * question nobody can act on wastes a slot from a finite budget.
 */
export function selectQuestions(
  drafts: readonly QuestionDraft[],
  understanding: Understanding,
  verdict: SufficiencyVerdict,
  cap: number,
): QuestionDraft[] {
  const dimensionOf = new Map(understanding.gaps.map((gap) => [gap.id as string, gap.dimension]));

  const rank = (draft: QuestionDraft): number => {
    const dimension = dimensionOf.get(draft.gapId);
    const index = dimension === undefined ? -1 : verdict.shortfalls.indexOf(dimension);
    // Dimensions that are not shortfalls sort after those that are, preserving
    // the model's own ordering within each band.
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };

  return drafts
    .filter((draft) => dimensionOf.has(draft.gapId))
    .map((draft, order) => ({ draft, order, rank: rank(draft) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, cap)
    .map((entry) => entry.draft);
}

/** Pairs each answer with its question, validating before anything costs tokens. */
async function resolveAnswers(
  deps: EngineDeps,
  answers: readonly Answer[],
): Promise<AnsweredQuestion[]> {
  const paired: AnsweredQuestion[] = [];

  for (const answer of answers) {
    const question = await deps.inquiry.findQuestion(answer.questionId);
    if (question === null) {
      throw new CapabilityError(
        'answer-intake',
        'engine',
        `answer ${answer.id} refers to unknown question ${answer.questionId}`,
      );
    }
    validateAnswer(question, answer);
    paired.push({ question, answer });
  }

  return paired;
}

async function loadSources(
  repository: SourceRepository,
  sessionId: SessionId,
  ids: readonly SourceId[],
): Promise<Source[]> {
  const loaded: Source[] = [];
  for (const id of ids) {
    const source = await repository.findById(sessionId, id);
    if (source !== null) loaded.push(source);
  }
  return loaded;
}

/**
 * One iteration of the gathering loop.
 *
 * Order matters and is load-bearing: answers are validated before any model call
 * so a malformed answer costs nothing, and the session is only written once the
 * turn has fully succeeded.
 */
export async function runTurn(
  session: Session,
  request: TurnRequest,
  deps: EngineDeps,
): Promise<TurnCommit> {
  const startedAt = deps.clock.now();

  const answered = await resolveAnswers(deps, request.answers ?? []);
  const newSources = await loadSources(deps.sources, session.id, request.sourceIds ?? []);
  const previous = await deps.revisions.findLatest(session.id);
  const current = previous?.content ?? emptyUnderstanding();

  const turnId = TurnId.parse(deps.ids.next('turn'));

  // Guarded so a strategy calling it twice fails immediately rather than
  // producing a revision built from two conflicting ID sequences.
  // Which answer closed which gap. Derivable — a Question carries its gapId and
  // an Answer carries its questionId — so the model is never asked to state it.
  const resolvedBy = new Map<string, AnswerId>(
    answered.map(({ question, answer }) => [question.gapId, answer.id]),
  );

  let merged = false;
  const merge: Merge = (delta) => {
    if (merged) throw new Error('the delta was applied more than once in a single turn');
    merged = true;
    return applyDelta(current, delta, { resolvedBy });
  };

  const analysis = await deps.strategy(
    deps,
    { session, understanding: current, newSources, answered },
    merge,
  );

  const understanding = analysis.understanding;

  const verdict = decideSufficiency(
    {
      ...analysis.assessment,
      blockingGapIds: resolveBlockingGaps(understanding, analysis.assessment),
    },
    deps.policy,
    { questionsAsked: session.questionsAsked, questionBudget: session.questionBudget },
  );

  // Each turn appends exactly one revision, so this number is also the turn's
  // index. Deriving it once removes both a repository read and a way for the
  // two sequences to disagree.
  const revisionNumber = (previous?.revision ?? -1) + 1;

  const revision = UnderstandingRevision.parse({
    id: RevisionId.parse(deps.ids.next('revision')),
    sessionId: session.id,
    revision: revisionNumber,
    producedByTurnId: turnId,
    content: understanding,
    createdAt: startedAt,
  });

  const usage = [...analysis.usage];
  let questions: Question[] = [];
  let status: Session['status'];

  const budgetRemaining = Math.max(0, session.questionBudget - session.questionsAsked);

  if (verdict.sufficient) {
    status = 'sufficient';
  } else if (budgetRemaining === 0) {
    status = 'exhausted';
  } else {
    const cap = Math.min(deps.maxQuestionsPerTurn, budgetRemaining);
    const drafted = await generateQuestions(deps, understanding, verdict, cap);
    usage.push(drafted.usage);

    const selected = selectQuestions(drafted.value, understanding, verdict, cap);
    if (selected.length === 0) {
      throw new CapabilityError(
        'generate-questions',
        'engine',
        'not sufficient, but no askable question targets an open gap — analysis recorded coverage shortfalls without gaps to close them',
      );
    }

    questions = materializeQuestions(selected, { sessionId: session.id, turnId }, deps);
    status = 'awaiting-answers';
  }

  // Fails loudly if the loop ever tries an illegal move — cheap insurance on the
  // one invariant that matters: nothing finalizes without a recorded verdict.
  assertTransition(session.status, status);

  const completedAt = deps.clock.now();

  const turn: Turn = {
    id: turnId,
    sessionId: session.id,
    index: revisionNumber,
    trigger: request.trigger,
    inputSourceIds: newSources.map((source) => source.id),
    inputAnswerIds: answered.map(({ answer }) => answer.id),
    understandingBefore: previous?.id ?? null,
    understandingAfter: revision.id,
    verdict,
    usage,
    startedAt,
    completedAt,
  };

  const nextSession: Session = {
    ...session,
    status,
    questionsAsked: session.questionsAsked + questions.length,
    currentRevisionId: revision.id,
    updatedAt: completedAt,
  };

  // Parsing here runs the command's cross-field checks, so an engine bug that
  // produced an incoherent turn fails now rather than becoming a data problem.
  return TurnCommit.parse({
    session: nextSession,
    revision,
    turn,
    questions,
    answers: answered.map(({ answer }) => answer),
  });
}
