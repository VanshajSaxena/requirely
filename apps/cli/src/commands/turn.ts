import {
  Answer,
  AnswerId,
  type Question,
  type SourceId,
  sumUsage,
  type TurnCommit,
  validateAnswer,
} from '@requirely/core/domain';
import { runTurn } from '@requirely/core/server';
import type { Asker } from '../asker.ts';
import { CANCELLED } from '../asker.ts';
import type { CliRuntime } from '../compose.ts';
import {
  describeStatus,
  heading,
  note,
  renderAnswer,
  renderVerdict,
  usageLine,
} from '../render.ts';
import { requireSession } from './session.ts';

/**
 * The loop: `turn` and `answer`.
 *
 * Both end in the same two visible steps, and that is not incidental —
 * `runTurn` reads, calls models and returns a `TurnCommit` **without writing**;
 * a separate `commit()` persists it in one transaction. Showing them as two
 * steps in the output keeps the architecture legible from the terminal, and
 * means a failed model call leaves nothing behind rather than half a turn.
 */

async function runAndCommit(
  runtime: CliRuntime,
  session: Awaited<ReturnType<typeof requireSession>>,
  request: Parameters<typeof runTurn>[1],
): Promise<{ commit: TurnCommit; lines: string[] }> {
  const commit = await runTurn(session, request, runtime.deps);

  const usage = sumUsage([...commit.turn.usage]);
  const lines = [
    heading('This turn'),
    note(`${commit.turn.usage.length} model call(s)`),
    usageLine(usage),
    '',
    renderVerdict(commit.turn.verdict),
    '',
    describeStatus(commit.session.status),
  ];

  await runtime.committer.commit(commit);
  return { commit, lines };
}

export async function runOneTurn(
  runtime: CliRuntime,
  sessionId: string,
  options: { sources?: readonly string[] | undefined } = {},
): Promise<string[]> {
  const session = await requireSession(runtime, sessionId);

  // Default to every source the session has. A user who ran `add` twice and then
  // `turn` means "look at what I gave you", not "look at the last thing".
  const all = await runtime.stores.sources.listBySession(session.id);
  const sourceIds = (options.sources ?? all.map((source) => source.id)) as readonly SourceId[];

  const { commit, lines } = await runAndCommit(runtime, session, {
    trigger: 'initial',
    sourceIds,
  });

  if (commit.questions.length > 0) {
    lines.push('', note(`${commit.questions.length} question(s) — requirely answer ${session.id}`));
  }
  return lines;
}

/**
 * Answer the outstanding questions, then fold them back in.
 *
 * **Every answer is validated at the prompt, before any model call.** That is
 * the whole reason the loop validates eagerly: a malformed answer discovered
 * inside `runTurn` would already have cost three calls, and the user would be
 * told about it after paying. Here they simply retype.
 */
export async function answerQuestions(
  runtime: CliRuntime,
  sessionId: string,
  asker: Asker,
): Promise<string[]> {
  const session = await requireSession(runtime, sessionId);
  const pending = await runtime.stores.inquiry.listUnansweredQuestions(session.id);

  if (pending.length === 0) {
    return [note('Nothing to answer. Run `requirely turn` to make progress.')];
  }

  const answers: Answer[] = [];
  const transcript: string[] = [];

  for (const [index, question] of pending.entries()) {
    const reply = await asker.ask(question, index, pending.length);
    if (reply === CANCELLED) {
      return [note(`Stopped after ${answers.length} of ${pending.length}. Nothing was saved.`)];
    }

    const answer = buildAnswer(runtime, question, reply);

    // Eagerly, at the prompt. `runTurn` validates too — that is the contract —
    // but by then the user has walked away and a rejection costs a round trip.
    try {
      validateAnswer(question, answer);
    } catch (error) {
      return [
        note(
          `That answer does not work: ${error instanceof Error ? error.message : String(error)}`,
        ),
        note('Nothing was saved. Run the command again.'),
      ];
    }

    answers.push(answer);
    transcript.push(renderAnswer(question, answer));
  }

  const { lines } = await runAndCommit(runtime, session, {
    trigger: 'answers-received',
    answers,
  });

  return [...transcript, ...lines];
}

/**
 * Turns a reply into an `Answer`.
 *
 * **The id comes from `ids.next('answer')`, never from a counter here.** The
 * shared test fixture mints `ans-1` per turn and collides across a persisted
 * session — a trap Phase 7 predicted and Phase 8 hit for real when a three-turn
 * test failed on a primary-key conflict. Production has an `IdGenerator`
 * precisely so this cannot happen.
 */
function buildAnswer(
  runtime: CliRuntime,
  question: Question,
  reply: { readonly selectedOptionIds: readonly string[]; readonly customText: string | null },
): Answer {
  return Answer.parse({
    id: AnswerId.parse(runtime.deps.ids.next('answer')),
    questionId: question.id,
    selectedOptionIds: [...reply.selectedOptionIds],
    customText: reply.customText,
    answeredAt: runtime.deps.clock.now(),
  });
}
