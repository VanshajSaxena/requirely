import {
  type Answer,
  measureProgress,
  type Question,
  type Session,
  sumUsage,
  type Turn,
  type Understanding,
  type UsageTotals,
} from '../domain/index.ts';

/**
 * What a gathering session actually cost and how it went.
 *
 * **Every number here is derived from data the session already stores.** That is
 * the constraint that shaped it: an instrument that needed new fields would make
 * the measurement expensive enough to skip, and a measurement you skip is a
 * design argument you have to win with opinions instead.
 *
 * Pure over its inputs, so it is unit-testable without a model — which matters
 * more than usual, because the *readings* need a live provider and the
 * *arithmetic* must not. Tests pin the arithmetic; the live evals supply the
 * numbers.
 *
 * `repairs` is the one thing not derivable from stored data — `Generated.repairs`
 * is a per-call fact that never reaches `Turn` — so it arrives from a
 * `CallMeter` when one was attached, and is `null` when one was not. Null rather
 * than zero, for the same reason `Usage.costMinorUnits` is: "not observed" and
 * "observed to be none" are different claims.
 */

export interface MetricsInput {
  readonly session: Session;
  readonly turns: readonly Turn[];
  readonly questions: readonly Question[];
  readonly answers: readonly Answer[];
  readonly understanding: Understanding;
  /** Repair counts per call, when a `CallMeter` was attached. */
  readonly repairsPerCall?: readonly number[] | undefined;
}

export interface SessionMetrics {
  readonly finalStatus: Session['status'];
  readonly turns: number;
  /** Model calls across the whole session — the number a strategy choice moves. */
  readonly calls: number;
  readonly usage: UsageTotals;
  /**
   * Which turn first reached `sufficient`, 1-based. Null if it never did.
   *
   * The headline quality number: two configurations that both finish are
   * separated by how much it cost to get there, and this is the other half of
   * that with `calls`.
   */
  readonly turnsToSufficient: number | null;
  /** Turns whose verdict recorded no new settlement. */
  readonly turnsWithoutProgress: number;
  readonly questionsAsked: number;
  /** Settled fraction at the end — the goal the whole design is pointed at. */
  readonly settledRatio: number;
  readonly decisions: number;
  readonly openItems: number;
  /**
   * How often the user took the option Requirely suggested.
   *
   * **The anchoring instrument.** Defaults in AI decision support are documented
   * as strong anchors — one clinical survey found 88% of residents had
   * encountered the effect — so a rate near 1.0 is the signal that Requirely
   * stopped offering a choice and started making it, dressed as advice.
   *
   * Null when no question carried a recommendation: a rate over zero offers is
   * not 0%, it is undefined, and reporting it as 0% would read as "the user
   * always disagrees".
   */
  readonly recommendationAcceptance: number | null;
  readonly recommendationsOffered: number;
  /**
   * Assumptions created per turn, including ones later promoted away.
   *
   * The owner's concern was overuse; the control is a prompt instruction naming
   * an assumption a last resort, and this is the instrument that says whether
   * the control works. Counting only *current* assumptions would hide every one
   * that got promoted, which is exactly the overuse worth seeing.
   */
  readonly assumptionsPerTurn: number;
  readonly assumptionsMade: number;
  /** Repairs across all calls, or null when nothing was metering them. */
  readonly repairs: number | null;
}

export function sessionMetrics(input: MetricsInput): SessionMetrics {
  const { turns, understanding } = input;
  const progress = measureProgress(understanding);

  const sufficientAt = turns.findIndex((turn) => turn.verdict.sufficient);

  // An assumption promoted to a Decision has left the collection, so counting
  // only what remains would hide the ones that were acted on — the opposite of
  // what an overuse instrument should do.
  const promotedAssumptions = understanding.decisions.filter(
    (decision) => decision.promotedFrom?.startsWith('asm-') ?? false,
  ).length;
  const assumptionsMade = understanding.assumptions.length + promotedAssumptions;

  const recommended = input.questions.filter((question) => question.recommends !== null);
  const answersByQuestion = new Map(
    input.answers.map((answer) => [answer.questionId as string, answer]),
  );
  const accepted = recommended.filter(
    (question) =>
      answersByQuestion
        .get(question.id)
        ?.selectedOptionIds.some((id) => id === question.recommends) ?? false,
  ).length;

  return {
    finalStatus: input.session.status,
    turns: turns.length,
    calls: turns.reduce((total, turn) => total + turn.usage.length, 0),
    usage: sumUsage(turns.flatMap((turn) => [...turn.usage])),
    turnsToSufficient: sufficientAt === -1 ? null : sufficientAt + 1,
    turnsWithoutProgress: turns.filter((turn) => turn.verdict.turnsWithoutProgress > 0).length,
    questionsAsked: input.questions.length,
    settledRatio: progress.ratio,
    decisions: progress.decisions,
    openItems: progress.open,
    recommendationAcceptance: recommended.length === 0 ? null : accepted / recommended.length,
    recommendationsOffered: recommended.length,
    assumptionsPerTurn: turns.length === 0 ? 0 : assumptionsMade / turns.length,
    assumptionsMade,
    repairs:
      input.repairsPerCall === undefined
        ? null
        : input.repairsPerCall.reduce((total, count) => total + count, 0),
  };
}

/** One line per metric, for a test that reports rather than only asserts. */
export function formatMetrics(label: string, metrics: SessionMetrics): string {
  const cost =
    metrics.usage.costMinorUnits === null
      ? 'cost unknown'
      : `$${(metrics.usage.costMinorUnits / 100).toFixed(4)}`;
  const acceptance =
    metrics.recommendationAcceptance === null
      ? 'n/a'
      : `${(metrics.recommendationAcceptance * 100).toFixed(0)}% of ${metrics.recommendationsOffered}`;

  return [
    `${label}: ${metrics.finalStatus} after ${metrics.turns} turn(s), ${metrics.calls} calls`,
    `${label}: ${metrics.usage.inputTokens} in / ${metrics.usage.outputTokens} out · ${cost}`,
    `${label}: settled ${metrics.decisions}/${metrics.decisions + metrics.openItems} (${(metrics.settledRatio * 100).toFixed(0)}%), sufficient at turn ${metrics.turnsToSufficient ?? '—'}`,
    `${label}: recommendations taken ${acceptance} · assumptions/turn ${metrics.assumptionsPerTurn.toFixed(2)} · repairs ${metrics.repairs ?? 'not metered'}`,
  ].join('\n');
}
