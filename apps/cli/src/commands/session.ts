import {
  createSession,
  emptyUnderstanding,
  type Session,
  SessionId,
  type Temperament,
} from '@requirely/core/domain';
import { sessionMetrics } from '@requirely/core/server';
import type { CliRuntime } from '../compose.ts';
import {
  describeStatus,
  dialsLine,
  heading,
  note,
  renderSources,
  renderUnderstanding,
  renderVerdict,
  sessionLine,
  usageLine,
} from '../render.ts';

/**
 * Session lifecycle and inspection: `new`, `ls`, `status`.
 *
 * Grouped by *layer* rather than one file per verb. These three touch only the
 * session and its stored revisions — no model, no ingestion, no projection —
 * which is the same seam the architecture is organised along everywhere else.
 * A file per verb would spread one concern across three ten-line files.
 */

export async function newSession(
  runtime: CliRuntime,
  options: {
    title?: string | undefined;
    budget?: number | undefined;
    temperament?: Temperament | undefined;
  },
): Promise<string[]> {
  const session = createSession(
    {
      questionBudget: options.budget ?? runtime.config.questionBudget,
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.temperament === undefined ? {} : { temperament: options.temperament }),
    },
    runtime.deps,
  );
  await runtime.stores.sessions.create(session);

  return [
    `Created ${session.id}`,
    note(`  budget: ${session.questionBudget} questions`),
    // Echoed at creation because the dials are set once and then shape every
    // turn silently. A user who mistyped `--creativity 9` should find out here,
    // not from a document that reads oddly three turns later.
    note(`  ${dialsLine(session.temperament)}`),
    note('  next: requirely add <id> <file>'),
  ];
}

export async function listSessions(
  runtime: CliRuntime,
  options: { limit?: number | undefined },
): Promise<string[]> {
  const sessions = await runtime.stores.sessions.listRecent(options.limit ?? 20);
  if (sessions.length === 0) {
    return [note('No sessions yet. Start one with `requirely new --title "..."`.')];
  }
  return sessions.map(sessionLine);
}

/**
 * Everything known about a session, without spending a token.
 *
 * **No model call, deliberately.** `status` is the command a user runs
 * repeatedly, and one that cost money would train them not to. Everything here
 * is read from what previous turns already stored.
 */
export async function showStatus(runtime: CliRuntime, id: string): Promise<string[]> {
  const session = await requireSession(runtime, id);
  const revision = await runtime.stores.understanding.findLatest(session.id);
  const turns = await runtime.stores.sessions.listTurns(session.id);
  const sources = await runtime.stores.sources.listBySession(session.id);
  const questions = await runtime.stores.inquiry.listQuestions(session.id);
  const answers = await runtime.stores.inquiry.listAnswers(session.id);

  const metrics = sessionMetrics({
    session,
    turns,
    questions,
    answers,
    understanding: revision?.content ?? emptyUnderstanding(),
  });

  const lines = [
    `${session.title ?? '(untitled)'}  ${note(session.id)}`,
    describeStatus(session.status),
    note(`  ${dialsLine(session.temperament)}`),
    '',
    note(
      `revision ${revision?.revision ?? '—'} · ${metrics.turns} turn(s) · ${metrics.calls} model call(s)`,
    ),
    usageLine(metrics.usage),
    heading('Input'),
    renderSources(sources),
  ];

  if (revision !== null) {
    lines.push('', renderUnderstanding(revision.content));
  }

  const latest = turns.at(-1);
  if (latest !== undefined) {
    lines.push('', renderVerdict(latest.verdict));
  }

  const unanswered = await runtime.stores.inquiry.listUnansweredQuestions(session.id);
  if (unanswered.length > 0) {
    lines.push(
      '',
      note(`${unanswered.length} question(s) waiting — requirely answer ${session.id}`),
    );
  }

  return lines;
}

/**
 * Loads a session or fails with something a user can act on.
 *
 * Shared rather than repeated: every command but `new` and `ls` starts this way,
 * and "session not found" is the single most likely thing a user will see.
 */
export async function requireSession(runtime: CliRuntime, id: string): Promise<Session> {
  const session = await runtime.stores.sessions.findById(SessionId.parse(id));
  if (session === null) {
    throw new Error(`No session ${id}. Run \`requirely ls\` to see recent ones.`);
  }
  return session;
}
