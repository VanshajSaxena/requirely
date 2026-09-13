import * as clack from '@clack/prompts';
import type { AnswerDisposition, Question } from '@requirely/core/domain';
import { renderQuestion } from './render.ts';

/**
 * Asking a human something, behind a port.
 *
 * The same reasoning that put models behind `StructuredGenerator`: an
 * interactive prompt is an I/O boundary, and a CLI whose only implementation is
 * "read from a real TTY" cannot be tested at all. With this, a full
 * `new → add → turn → answer → generate` run is a `vitest` test with a scripted
 * answerer and zero spend — which is the only way the deliberation trail gets
 * exercised against real repository data rather than hand-built fixtures.
 *
 * Deliberately *not* in `packages/core`. Nothing below an application asks a
 * human anything, and a port with no consumer in the library is a seam with no
 * user — the shape this codebase has already deleted once.
 */

export interface Reply {
  /**
   * Defaults to `answered`.
   *
   * The other two are what a person actually does when they do not know: park it
   * (`deferred`), or hand it over (`delegated`). Before these existed the only
   * legal replies were a choice and a written one, so "I don't know" had to be
   * typed as prose and then read by a model as if it were an opinion.
   */
  readonly disposition?: AnswerDisposition | undefined;
  /** Ids of options the user selected. Empty when they wrote their own answer. */
  readonly selectedOptionIds: readonly string[];
  readonly customText: string | null;
}

export interface Asker {
  ask(question: Question, index: number, total: number): Promise<Reply | null>;
  say(message: string): void;
}

/** Distinguishes "the user pressed Ctrl-C" from "the user answered nothing". */
export const CANCELLED = null;

/** Written by hand rather than taken from clack, so no vendor value crosses the port. */
const WRITE_MY_OWN = '__custom__';
const SKIP = '__defer__';
const DELEGATE = '__delegate__';

/**
 * The real one.
 *
 * **The recommendation is never a pre-selection.** `clack.select` accepts an
 * `initialValue`, and pointing it at `Question.recommends` would put the cursor
 * on our opinion and make every other option a move away from it. The
 * recommendation is printed by `renderQuestion` *after* the option list instead,
 * with its reasoning, so the user reads the choices before the advice. That is
 * the domain's "a UI can withhold it" made concrete, and it is the single most
 * load-bearing line in this file.
 */
export function clackAsker(): Asker {
  return {
    say(message) {
      clack.log.message(message);
    },

    async ask(question, index, total) {
      clack.log.message(renderQuestion(question, index, total));

      // Zero options means a genuinely open question — go straight to prose
      // rather than offering a list of one thing.
      if (question.options.length === 0) {
        const written = await clack.text({
          message: 'Your answer',
          placeholder: 'in your own words',
        });
        if (clack.isCancel(written)) return CANCELLED;
        return { selectedOptionIds: [], customText: written.trim() || null };
      }

      const choices = [
        ...question.options.map((option) => ({ value: option.id as string, label: option.label })),
        // Always present, because `allowsCustom` is a product invariant pinned in
        // the type: it must never be possible to construct a question that
        // forbids a written answer.
        { value: WRITE_MY_OWN, label: 'Something else — let me write it' },
        // Last, deliberately. These are the honest replies for someone who does
        // not know, and they must be available without being the first thing the
        // eye lands on — the same anchoring argument that keeps the
        // recommendation out of `initialValue`.
        { value: DELEGATE, label: "I don't know — you decide, and I'll correct you" },
        { value: SKIP, label: 'Skip for now — ask me again later' },
      ];

      const picked =
        question.mode === 'multiple'
          ? await clack.multiselect({
              message: 'Pick what applies',
              options: choices,
              required: false,
            })
          : await clack.select({ message: 'Pick one', options: choices });

      if (clack.isCancel(picked)) return CANCELLED;

      const selected = (Array.isArray(picked) ? picked : [picked]).filter(
        (value): value is string => typeof value === 'string',
      );

      // Both escape hatches still take a note, because someone who cannot answer
      // often knows *why* — "ask legal first", "whatever is cheapest" — and that
      // is real steering. `validateAnswer` permits text on either; what it
      // forbids is a selection, since picking an option is answering.
      for (const [sentinel, disposition] of [
        [DELEGATE, 'delegated'],
        [SKIP, 'deferred'],
      ] as const) {
        if (!selected.includes(sentinel)) continue;
        const note = await clack.text({
          message: disposition === 'delegated' ? 'Anything to steer us by?' : 'Why, if it helps?',
          placeholder: 'optional',
        });
        if (clack.isCancel(note)) return CANCELLED;
        return { disposition, selectedOptionIds: [], customText: note.trim() || null };
      }

      if (!selected.includes(WRITE_MY_OWN)) {
        return { selectedOptionIds: selected, customText: null };
      }

      const written = await clack.text({
        message: 'In your own words',
        placeholder: 'what the options missed',
      });
      if (clack.isCancel(written)) return CANCELLED;

      return {
        selectedOptionIds: selected.filter((value) => value !== WRITE_MY_OWN),
        customText: written.trim() || null,
      };
    },
  };
}

/**
 * A scripted answerer, for tests and for `--auto`.
 *
 * `pick` receives the question and returns a reply, so a test can express
 * "always take the first option", "always write prose", or "deliberately reject
 * the recommendation" — the last of which is what makes the anchoring instrument
 * measurable at zero cost.
 */
export function scriptedAsker(
  pick: (question: Question, index: number) => Reply | null,
  onSay: (message: string) => void = () => {},
): Asker {
  return {
    say: onSay,
    ask: async (question, index) => pick(question, index),
  };
}

/** Takes the first option, or writes a placeholder when a question offers none. */
export const takeFirstOption = (question: Question): Reply =>
  question.options[0] === undefined
    ? { selectedOptionIds: [], customText: 'No preference — use your judgement.' }
    : { selectedOptionIds: [question.options[0].id], customText: null };
