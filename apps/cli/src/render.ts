import {
  type Answer,
  currentDecisions,
  type Decision,
  DIAL_NAMES,
  type OpenItem,
  openItems,
  type Question,
  type Session,
  type Source,
  type SufficiencyVerdict,
  type Temperament,
  type Understanding,
  type UsageTotals,
} from '@requirely/core/domain';

/**
 * Everything the CLI prints, as pure functions.
 *
 * Kept out of the commands so the output is testable without spawning a process
 * or capturing stdout. A command decides *what* to say and this decides *how* —
 * which also means the day a second front door exists, the wording is not
 * trapped inside argument parsing.
 */

/**
 * Written as escapes rather than literal control bytes.
 *
 * A raw `ESC` byte in source is invisible in a diff, survives a copy-paste as
 * something else, and makes the file unreadable in half the tools that will ever
 * open it. `\u001b` says exactly what it is.
 */
const ESC = '\u001b[';
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
const RESET = `${ESC}0m`;

/** Colour is a courtesy, not a channel. Off when stdout is not a terminal, and `NO_COLOR` wins. */
const colour = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const dim = (text: string): string => (colour ? `${DIM}${text}${RESET}` : text);
const bold = (text: string): string => (colour ? `${BOLD}${text}${RESET}` : text);

export const statementOf = (item: OpenItem): string =>
  'statement' in item ? item.statement : item.description;

/**
 * Why the session is where it is, in words a user can act on.
 *
 * The three stopping states mean different things and the difference is the only
 * actionable part: `exhausted` says raise the budget, `stalled` says the
 * questions are not landing so better *input* is what is needed.
 */
export function describeStatus(status: Session['status']): string {
  switch (status) {
    case 'gathering':
      return 'gathering — add input, then run a turn';
    case 'awaiting-answers':
      return 'awaiting answers — run `requirely answer <id>`';
    case 'sufficient':
      return 'sufficient — enough is settled to generate a document';
    case 'exhausted':
      return 'exhausted — the question budget ran out before everything was settled';
    case 'stalled':
      return 'stalled — recent turns settled nothing new; more questions are unlikely to help';
    case 'finalized':
      return 'finalized';
  }
}

export function sessionLine(session: Session): string {
  const title = session.title ?? '(untitled)';
  return `${session.id}  ${title}  ${dim(session.status)}  ${dim(session.updatedAt)}`;
}

/** `$0.1234`, or an honest admission that nothing reported a price. */
export function formatCost(usage: UsageTotals): string {
  return usage.costMinorUnits === null
    ? 'cost unknown'
    : `$${(usage.costMinorUnits / 100).toFixed(4)}`;
}

export function usageLine(usage: UsageTotals): string {
  return dim(`${usage.inputTokens} in / ${usage.outputTokens} out · ${formatCost(usage)}`);
}

const decisionLine = (decision: Decision): string =>
  `  ${bold(decision.id)} (${decision.kind}/${decision.dimension}) ${decision.statement}`;

const openLine = (item: OpenItem): string =>
  `  ${bold(item.id)} (${item.dimension})${item.blocking ? ' BLOCKING' : ''} ${statementOf(item)}`;

/**
 * What the session knows, settled first.
 *
 * The ordering is the product's thesis in a terminal: decisions are what has
 * been agreed, open items are what has not, and the loop's job is moving things
 * from the second list to the first. Printing requirements first — as this would
 * have before the redesign — shows a pile of proposals as though they were
 * conclusions.
 */
export function renderUnderstanding(understanding: Understanding): string {
  const decided = currentDecisions(understanding);
  const open = openItems(understanding);

  return [
    `${bold('Settled')} — ${decided.length} decision${decided.length === 1 ? '' : 's'}`,
    decided.length === 0 ? dim('  (nothing yet)') : decided.map(decisionLine).join('\n'),
    '',
    `${bold('Open')} — ${open.length} item${open.length === 1 ? '' : 's'}`,
    open.length === 0 ? dim('  (nothing open)') : open.map(openLine).join('\n'),
  ].join('\n');
}

export function renderVerdict(verdict: SufficiencyVerdict): string {
  const { settled } = verdict;
  const lines = [
    `${bold('Verdict')}  ${verdict.rationale}`,
    dim(
      `  settled ${settled.decisions}/${settled.decisions + settled.open} (${(settled.ratio * 100).toFixed(0)}%) · questions ${verdict.questionsAsked}/${verdict.questionBudget}`,
    ),
  ];

  if (verdict.shortfalls.length > 0) {
    lines.push(dim(`  weakest first: ${verdict.shortfalls.join(', ')}`));
  }
  if (verdict.turnsWithoutProgress > 0) {
    lines.push(dim(`  ${verdict.turnsWithoutProgress} turn(s) in a row settled nothing new`));
  }
  return lines.join('\n');
}

export function renderSources(sources: readonly Source[]): string {
  if (sources.length === 0) return dim('  (no input yet)');
  return sources
    .map(
      (source) =>
        `  ${bold(source.id)} ${source.origin.label} ${dim(`(${source.kind}, ${source.status})`)}`,
    )
    .join('\n');
}

/**
 * A question, with the recommendation **after** the options and never as a
 * pre-selection.
 *
 * This is the anchoring mitigation made concrete. `@clack/prompts`' `select`
 * takes an `initialValue`; pointing it at `Question.recommends` would put the
 * cursor on our opinion and make every other option a deliberate move away from
 * it — the textbook anchoring effect of a pre-selected default.
 *
 * So the user reads the choices, then reads what we would do and why. Choosing
 * against it costs nothing, and nothing in the system records it as a deviation.
 */
export function renderQuestion(question: Question, index: number, total: number): string {
  const lines = [
    `${dim(`(${index + 1}/${total})`)} ${bold(question.text)}`,
    dim(`  why we ask: ${question.rationale}`),
  ];

  for (const option of question.options) {
    lines.push(`  · ${option.label}`);
    lines.push(dim(`      ${option.means}`));
  }

  const recommended = question.options.find((option) => option.id === question.recommends);
  if (recommended !== undefined && question.because !== null) {
    lines.push('');
    lines.push(dim(`  if it helps: we would pick "${recommended.label}" — ${question.because}`));
    lines.push(dim('  picking anything else is an equally good answer.'));
  }

  return lines.join('\n');
}

/** What the user actually said, echoed back so a scripted run reads as a transcript. */
export function renderAnswer(question: Question, answer: Answer): string {
  const chosen = answer.selectedOptionIds
    .map((id) => question.options.find((option) => option.id === id)?.label ?? id)
    .join('; ');

  // A disposition other than `answered` carries no selection, so without this
  // the transcript would echo an empty line for exactly the replies a user is
  // most likely to want to see confirmed.
  const said =
    answer.disposition === 'delegated'
      ? 'asked us to decide'
      : answer.disposition === 'deferred'
        ? 'skipped for now'
        : chosen.length > 0
          ? `chose: ${chosen}`
          : '';

  const parts = [said, answer.customText ?? ''].filter((part) => part.length > 0);
  return dim(`  -> ${parts.join(' · ')}`);
}

/**
 * The five dials on one line.
 *
 * Printed at `new` and at `status` rather than hidden in a config file, because
 * they are set once and then shape every turn invisibly. A mistyped
 * `--creativity 0.9` that was meant to be `0.09` is only catchable if the value
 * is shown back; otherwise it surfaces three turns later as a document that
 * reads oddly and nobody knows why.
 */
export const dialsLine = (temperament: Temperament): string =>
  `dials  ${DIAL_NAMES.map((dial) => `${dial} ${temperament[dial].toFixed(2)}`).join(' · ')}`;

/**
 * One line a person can act on, from whatever was thrown.
 *
 * **A `ZodError`'s `message` is a JSON dump of its `issues`**, and `main.ts`
 * prints `error.message` — so any validation failure that reached the top of the
 * CLI arrived as a twelve-line array with no sentence in it. That happened twice:
 * once for `--creativity 9`, patched at the point of use, and once for a stored
 * row whose shape had drifted. Patching call sites one at a time was the wrong
 * shape of fix; this is the backstop.
 *
 * Duck-typed on `issues` rather than `instanceof ZodError`, because `apps/cli`
 * does not depend on zod and should not start in order to format an error.
 *
 * Core's `ConfigError` also carries `issues`, but as plain sentences, and its
 * message is already those sentences. Reading them as Zod issues turned a
 * missing API key into "(value): invalid" on a fresh clone, so an error whose
 * issues are all strings keeps its own message, and a stray string issue in a
 * mixed list is printed as it is.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return error.message;
  if (issues.every((issue) => typeof issue === 'string')) return error.message;

  const lines = issues.slice(0, 5).map((raw) => {
    if (typeof raw === 'string') return `  ${raw}`;
    const issue = raw as { path?: readonly unknown[]; message?: string };
    const where = (issue.path ?? []).join('.');
    return `  ${where === '' ? '(value)' : where}: ${issue.message ?? 'invalid'}`;
  });
  const more =
    issues.length > lines.length ? `\n  ...and ${issues.length - lines.length} more` : '';

  return `Some values did not match what was expected:\n${lines.join('\n')}${more}`;
}

export const heading = (text: string): string => `\n${bold(text)}`;
export const note = (text: string): string => dim(text);
