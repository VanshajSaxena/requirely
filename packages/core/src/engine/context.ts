import type {
  Answer,
  OpenItem,
  Question,
  Session,
  Source,
  SufficiencyVerdict,
  Understanding,
} from '../domain/index.ts';
import { currentDecisions, openItems } from '../domain/index.ts';

/**
 * Everything a model sees is assembled here and nowhere else.
 *
 * This is the single token seam. When context limits start to bind or spend
 * gets expensive, windowing, summarization, and retrieval through the `Embedder`
 * port all land in this file — without touching prompts, strategies, or the
 * loop. Keeping that concentrated is the whole reason rendering does not happen
 * inline at the call sites.
 *
 * Format note: a terse line format rather than JSON. JSON spends a meaningful
 * share of its tokens on braces and quotes, and models handle `[req_1] text`
 * just as reliably. IDs are bracketed so a model can echo them back exactly,
 * which is what the delta contract depends on.
 */

const section = (title: string, lines: readonly string[]): string =>
  lines.length === 0 ? '' : `## ${title}\n${lines.join('\n')}`;

const join = (blocks: readonly string[]): string => blocks.filter((b) => b.length > 0).join('\n\n');

/**
 * `[req-1 acceptance BLOCKING]` — id, lens, and veto flag in one bracket.
 *
 * Every open item carries the same three facts, so rendering them one way means
 * a model reads `[con-2 data]` and `[req-1 acceptance]` with the same grammar.
 * The dimension is inside the bracket on purpose: it is what a question targets
 * now that `Gap` is gone.
 */
const marker = (item: OpenItem): string =>
  `[${item.id} ${item.dimension}${item.blocking ? ' BLOCKING' : ''}]`;

export function renderSources(sources: readonly Source[]): string {
  if (sources.length === 0) return '';
  const blocks = sources.map(
    (source) =>
      `### [${source.id}] ${source.origin.label} (${source.kind})\n${source.normalizedText ?? '(not yet normalized)'}`,
  );
  return `## New input\n${blocks.join('\n\n')}`;
}

export interface AnsweredQuestion {
  readonly question: Question;
  readonly answer: Answer;
}

export function renderAnswers(answered: readonly AnsweredQuestion[]): string {
  const lines = answered.map(({ question, answer }) => {
    const chosen = answer.selectedOptionIds
      .map((id) => question.options.find((option) => option.id === id)?.label ?? id)
      .join('; ');
    const parts = [
      `- Q [${question.id}] (${question.dimension}${question.about === null ? '' : `, about ${question.about}`}): ${question.text}`,
      chosen.length > 0 ? `  chose: ${chosen}` : '',
      answer.customText !== null ? `  said: ${answer.customText}` : '',
      answer.additionalContext !== null ? `  also: ${answer.additionalContext}` : '',
    ];
    return parts.filter((p) => p.length > 0).join('\n');
  });
  return section('Answers received', lines);
}

/** Full detail, including provenance — what `analyze` needs to revise correctly. */
export function renderUnderstanding(understanding: Understanding): string {
  const { product } = understanding;
  const productLines = [
    product.name !== null ? `name: ${product.name}` : '',
    product.oneLiner !== null ? `one-liner: ${product.oneLiner}` : '',
    product.problem !== null ? `problem: ${product.problem}` : '',
    product.purpose !== null ? `purpose: ${product.purpose}` : '',
    ...product.users.map((user) => `user: ${user.label} — ${user.description ?? 'no description'}`),
  ].filter((line) => line.length > 0);

  return join([
    section('Product', productLines),
    section(
      'Settled decisions',
      currentDecisions(understanding).map(
        (d) =>
          `- [${d.id}] (${d.kind}/${d.dimension}) ${d.statement}\n    because: ${d.rationale}\n    settled by: ${d.settledBy}${d.promotedFrom === null ? '' : ` (was ${d.promotedFrom})`}`,
      ),
    ),
    section(
      'Open requirements',
      understanding.requirements.map((requirement) => {
        const cites = requirement.provenance
          .map((p) => p.quote ?? p.note ?? p.sourceId)
          .join(' | ');
        return `- ${marker(requirement)} (${requirement.kind}) ${requirement.statement}${cites ? `\n    cites: ${cites}` : ''}`;
      }),
    ),
    section(
      'Open constraints',
      understanding.constraints.map((c) => `- ${marker(c)} (${c.category}) ${c.statement}`),
    ),
    section(
      'Open assumptions',
      understanding.assumptions.map(
        (a) => `- ${marker(a)} (${a.risk} risk) ${a.statement} — ${a.basis}`,
      ),
    ),
    section(
      'Open contradictions',
      understanding.contradictions.map((c) => `- ${marker(c)} ${c.description}`),
    ),
  ]);
}

/**
 * Statements and IDs only — no provenance, no rationale, no decision history.
 *
 * `assess` scores coverage; it does not need citations to judge whether a
 * dimension is understood. Dropping them is the cheapest available token saving
 * and costs nothing the operation actually uses.
 */
export function compactUnderstanding(understanding: Understanding): string {
  const { product } = understanding;
  return join([
    section(
      'Product',
      [
        product.oneLiner !== null ? `one-liner: ${product.oneLiner}` : '',
        product.purpose !== null ? `purpose: ${product.purpose}` : '',
        product.users.length > 0 ? `users: ${product.users.map((u) => u.label).join(', ')}` : '',
      ].filter((l) => l.length > 0),
    ),
    section(
      'Settled decisions',
      currentDecisions(understanding).map(
        (d) => `- [${d.id}] (${d.kind}/${d.dimension}) ${d.statement}`,
      ),
    ),
    section(
      'Open requirements',
      understanding.requirements.map((r) => `- ${marker(r)} (${r.kind}) ${r.statement}`),
    ),
    section(
      'Open constraints',
      understanding.constraints.map((c) => `- ${marker(c)} ${c.statement}`),
    ),
    section(
      'Open assumptions',
      understanding.assumptions.map((a) => `- ${marker(a)} ${a.statement}`),
    ),
    section(
      'Open contradictions',
      understanding.contradictions.map((c) => `- ${marker(c)} ${c.description}`),
    ),
  ]);
}

export interface AnalyzeContext {
  readonly session: Session;
  readonly understanding: Understanding;
  readonly newSources: readonly Source[];
  readonly answered: readonly AnsweredQuestion[];
}

export function buildAnalyzeInput(context: AnalyzeContext): string {
  const target =
    context.session.outputTarget === null
      ? 'The user has not chosen an output format yet. Do not let that shape the analysis.'
      : `The user eventually wants: ${context.session.outputTarget}.`;

  return join([
    `# Current understanding\n${renderUnderstanding(context.understanding) || '(empty — this is the first turn)'}`,
    renderSources(context.newSources),
    renderAnswers(context.answered),
    target,
  ]);
}

export function buildAssessInput(understanding: Understanding): string {
  return `# Understanding to assess\n${compactUnderstanding(understanding) || '(empty)'}`;
}

export function buildQuestionsInput(
  understanding: Understanding,
  verdict: SufficiencyVerdict,
  maxQuestions: number,
): string {
  const weakest =
    verdict.shortfalls.length > 0
      ? `Weakest dimensions, worst first: ${verdict.shortfalls.join(', ')}.`
      : 'No dimension is below the bar; target the blocking open items.';

  // Only *open* items are sent. Settled decisions are omitted on purpose: sending
  // them invites the model to re-ask something already answered, and a question
  // that reopens a decision costs a slot from a finite budget to learn nothing.
  //
  // Note there is no equivalent of the old "you must target one of these" rule.
  // A question may name no item at all, because an absence has no entity — it is
  // a dimension with nothing behind it, and that is the most valuable thing to
  // ask about on turn one.
  const items = section(
    'Open items you may target',
    openItems(understanding).map((item) => `- ${marker(item)} ${statementOf(item)}`),
  );

  return join([
    `# Why we are not finished\n${verdict.rationale}\n${weakest}`,
    items,
    `Ask at most ${maxQuestions} questions. Most important first.`,
  ]);
}

/** The one human-readable line an open item has, whichever collection it came from. */
function statementOf(item: OpenItem): string {
  return 'statement' in item ? item.statement : item.description;
}
