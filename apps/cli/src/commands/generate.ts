import { writeFile } from 'node:fs/promises';
import { finalizeSession, OutputTarget } from '@requirely/core/domain';
import { project } from '@requirely/core/server';
import type { CliRuntime } from '../compose.ts';
import { note } from '../render.ts';
import { requireSession } from './session.ts';

/**
 * Projection: `generate <session> --target srs|requirements-doc|agent-prompt`.
 *
 * **This is the first real caller of `project()`**, and closing that gap is most
 * of the value of this command existing. Every other caller builds a
 * `ProjectionInput` by hand in a test, so the deliberation trail — *"we chose
 * SSO; we considered and rejected magic links because every sign-in would need a
 * working inbox"* — has only ever been proven against fixtures. Here the
 * questions and answers come out of a repository.
 *
 * Note what the CLI does and does not do. It **fetches**; the projection stays a
 * pure function of what it is handed. A projection that did its own I/O could
 * not be snapshot-tested and would be the first thing in that layer able to
 * fail.
 */

export async function generateDocument(
  runtime: CliRuntime,
  sessionId: string,
  options: { target: string; out?: string | undefined },
): Promise<string[]> {
  const target = OutputTarget.parse(options.target);
  const session = await requireSession(runtime, sessionId);

  const revision = await runtime.stores.understanding.findLatest(session.id);
  if (revision === null) {
    throw new Error(
      `Session ${session.id} has no understanding yet. Add input and run \`requirely turn\` first.`,
    );
  }

  // Finalizing is a separate, explicit act from rendering: projections are pure
  // and mutate nothing. `assertTransition` is what keeps `finalized` reachable
  // only from a state that carries a recorded verdict — a generated document
  // with no verdict behind it is exactly the confident output hiding its holes
  // that this design exists to prevent.
  const finalized = finalizeSession(session, target, runtime.deps);
  await runtime.stores.sessions.save(finalized);

  const document = project(target, {
    session: finalized,
    revision,
    sources: await runtime.stores.sources.listBySession(session.id),
    // The two that Phase 6 recorded as unreachable and Phase 8 Step 5 widened
    // the input to carry. Fetched here, because the caller holds the repository.
    questions: await runtime.stores.inquiry.listQuestions(session.id),
    answers: await runtime.stores.inquiry.listAnswers(session.id),
  });

  if (options.out === undefined) return [document];

  await writeFile(options.out, document, 'utf8');
  return [`Wrote ${options.out}`, note(`  ${document.length} characters · target ${target}`)];
}
