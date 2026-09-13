import {
  type Answer,
  type AnswerId,
  applyDelta,
  assertTransition,
  CapabilityError,
  type Clock,
  countsFor,
  decideSufficiency,
  emptyUnderstanding,
  type IdGenerator,
  type InquiryRepository,
  isAnalyzable,
  materializeQuestions,
  measureProgress,
  type OpenItemId,
  openItems,
  policyFor,
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
 * Reconciles the model's opinion about blocking items with what actually exists.
 *
 * Two sources of truth get unioned: items the analysis flagged `blocking`, and
 * items the assessment named. IDs that match no open item are **dropped, not
 * thrown** — unlike a delta, where a bad ID must fail the turn. The asymmetry is
 * deliberate: a hallucinated blocking item that survived would veto sufficiency
 * on every future turn, deadlocking the session permanently. A delta failing
 * loudly costs one retry; this failing loudly costs the whole session.
 *
 * Promotion makes the drop rule matter more, not less: an item named as blocking
 * on turn N may have become a Decision by turn N+1, so a stale id is now an
 * ordinary outcome of the loop working rather than a sign of model error.
 */
export function resolveBlockingItems(
  understanding: Understanding,
  assessment: UnderstandingAssessment,
): OpenItemId[] {
  const items = openItems(understanding);
  const open = new Set(items.map((item) => item.id as string));
  const flagged = items.filter((item) => item.blocking).map((item) => item.id as OpenItemId);
  const claimed = assessment.blockingItemIds.filter((id) => open.has(id));
  return [...new Set([...flagged, ...claimed])];
}

/**
 * Chooses which drafted questions to actually ask.
 *
 * Ordering comes from the domain's own computed shortfall order, not from a
 * priority number the model invents — the same reason `Requirement.confidence`
 * was removed.
 *
 * **The old "must target an open gap" filter is gone, and its absence is the
 * point.** A question used to be dropped unless it named a live `Gap`, which
 * meant a model could only ask about something it had first invented an entity
 * for. Now `dimension` is always valid, so a question about an *absence* — the
 * most valuable kind on turn one — survives. Only `about`, which is optional,
 * is checked, and a stale one is cleared rather than dropping the question:
 * the question is still worth asking, it just no longer settles that item.
 */
export function selectQuestions(
  drafts: readonly QuestionDraft[],
  understanding: Understanding,
  verdict: SufficiencyVerdict,
  cap: number,
): QuestionDraft[] {
  const open = new Set(openItems(understanding).map((item) => item.id as string));

  const rank = (draft: QuestionDraft): number => {
    const index = verdict.shortfalls.indexOf(draft.dimension);
    // Dimensions that are not shortfalls sort after those that are, preserving
    // the model's own ordering within each band.
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };

  return drafts
    .map((draft, order) => ({ draft, order, rank: rank(draft) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, cap)
    .map(({ draft }) =>
      draft.about !== null && !open.has(draft.about) ? { ...draft, about: null } : draft,
    );
}

/**
 * Which answer settled which open item.
 *
 * Two sources, and the second is what `QuestionOption.settles` buys. A question
 * names one item in `about`; each *option* may name more. So "which of these do
 * you actually need?" settles whichever ones were selected — and only those,
 * because an option nobody picked settles nothing.
 *
 * Derivable throughout, which is the point: a `Question` carries `about` and an
 * `Answer` carries its `questionId`, so the model is never asked to transcribe a
 * 40-character `AnswerId`.
 */
export function settlementsFrom(answered: readonly AnsweredQuestion[]): Map<string, AnswerId> {
  const settled = new Map<string, AnswerId>();

  for (const { question, answer } of answered) {
    if (question.about !== null) settled.set(question.about, answer.id);

    const chosen = new Set<string>(answer.selectedOptionIds);
    for (const option of question.options) {
      if (!chosen.has(option.id)) continue;
      for (const item of option.settles) settled.set(item, answer.id);
    }
  }

  return settled;
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

/**
 * Loads the turn's input sources, **skipping any that are not analyzable**.
 *
 * A source can exist without text: audio is persisted as `pending` while
 * transcription runs, and a failed extraction can leave a `failed` row. Sending
 * either to a model spends a turn on an empty document.
 *
 * This also makes an argument elsewhere checkable rather than merely true.
 * `SourceRepository.remove` lets ingestion delete a failed `pending` row, after
 * which the next source reuses its ordinal. That reuse is safe *because* a
 * pending source can never have been cited — and this line is what guarantees it
 * never reached a model to be cited from.
 */
async function loadSources(
  repository: SourceRepository,
  sessionId: SessionId,
  ids: readonly SourceId[],
): Promise<Source[]> {
  const loaded: Source[] = [];
  for (const id of ids) {
    const source = await repository.findById(sessionId, id);
    if (source !== null && isAnalyzable(source)) loaded.push(source);
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

  /**
   * The dials, resolved once for the whole turn.
   *
   * Read from the **session** rather than from `deps`, which is what makes
   * per-request dials additive later: this line becomes
   * `request.temperament ?? session.temperament` and nothing else moves. Putting
   * them in `EngineDeps` would have made them a property of the wiring, and two
   * sessions in one process could not then differ.
   *
   * `deps.policy` and `deps.maxQuestionsPerTurn` keep their jobs and change
   * meaning slightly: they are now the **base** and the **ceiling** that the
   * dials work within, never values a dial replaces.
   */
  const temperament = session.temperament;
  const policy = policyFor(temperament, deps.policy);
  const counts = countsFor(temperament, { maxQuestionsPerTurn: deps.maxQuestionsPerTurn });

  const settledBy = settlementsFrom(answered);

  // Every source the session has, so a model-cited `settledBySourceId` is checked
  // against reality rather than trusted. Loaded here rather than inside applyDelta
  // because the domain has no repository — which is the point of the port.
  const knownSourceIds = new Set(
    (await deps.sources.listBySession(session.id)).map((source) => source.id as string),
  );

  // Guarded so a strategy calling it twice fails immediately rather than
  // producing a revision built from two conflicting ID sequences.
  let merged = false;
  const merge: Merge = (delta) => {
    if (merged) throw new Error('the delta was applied more than once in a single turn');
    merged = true;
    return applyDelta(current, delta, { settledBy, knownSourceIds });
  };

  const analysis = await deps.strategy(
    deps,
    { session, understanding: current, newSources, answered },
    merge,
  );

  const understanding = analysis.understanding;

  // The stall counter travels on the previous *verdict*, which is the durable
  // record of what the loop concluded. Phase 3 removed a `listTurns` read for
  // `Turn.index` because that was derivable from the revision number; this one
  // is not derivable from anything, and one small read against three model calls
  // is not a cost worth a new port method or a duplicated counter on `Session`.
  const priorTurns = await deps.sessions.listTurns(session.id);
  const priorVerdict = priorTurns.at(-1)?.verdict ?? null;

  const verdict = decideSufficiency(
    {
      ...analysis.assessment,
      blockingItemIds: resolveBlockingItems(understanding, analysis.assessment),
    },
    policy,
    {
      questionsAsked: session.questionsAsked,
      questionBudget: session.questionBudget,
      settled: measureProgress(understanding),
      // Measured from the stored revision rather than carried in the session, so
      // a resumed session picks the trajectory back up for free.
      previous: previous === null ? null : measureProgress(previous.content),
      priorTurnsWithoutProgress: priorVerdict?.turnsWithoutProgress ?? 0,
    },
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
  } else if (verdict.stalled) {
    // Checked *after* `exhausted` on purpose: a turn that both ran out of budget
    // and stalled is still "out of budget", which is the half a user can act on
    // by raising it. Stalling with budget left is the interesting case — it says
    // spending the rest will not help.
    status = 'stalled';
  } else {
    // `counts.questionsPerTurn` is already clamped by `deps.maxQuestionsPerTurn`
    // inside `countsFor`; the session's remaining budget clamps it again here.
    // Two ceilings, neither of which a dial can raise.
    const cap = Math.min(counts.questionsPerTurn, budgetRemaining);
    const drafted = await generateQuestions(deps, understanding, verdict, cap);
    usage.push(drafted.usage);

    const selected = selectQuestions(drafted.value, understanding, verdict, cap);
    if (selected.length === 0) {
      throw new CapabilityError(
        'generate-questions',
        'engine',
        'not sufficient, but the model drafted no questions — the loop cannot advance without something to ask',
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
    temperament,
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
