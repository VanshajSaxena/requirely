import { describe, expect, it } from 'vitest';
import { UnderstandingAssessment } from '../../domain/index.ts';
import { AnalyzeAndAssessResult, QuestionDrafts } from '../../engine/steps.ts';
import { budgetOf } from '../../wire/budget.ts';
import { UnderstandingDeltaCodec } from '../../wire/index.ts';
import { ANTHROPIC_CAPS } from './anthropic.ts';
import { DEEPSEEK_CAPS } from './deepseek.ts';
import { GEMINI_CAPS } from './google.ts';
import { chooseMethod, type GrammarCaps } from './method.ts';
import { OPENAI_CAPS } from './openai.ts';

/**
 * **Every operation, against every provider's caps.**
 *
 * This is the gate that did not exist, and its absence cost a broken session.
 * `wire/codec.test.ts` asserts `CAPS = { optional: 24, union: 16 }` — Anthropic's
 * numbers, hard-coded — and measures only the wire codec. Nothing in the repo
 * knew there was more than one provider, so `assess` sat at one optional
 * property and `generate-questions` at six, both fine on Anthropic and both
 * unusable on OpenAI, until a real call said so.
 *
 * What it asserts is deliberately **not** "which method each cell picks today".
 * That would fail on every schema tweak and teach nobody anything. It asserts
 * the weaker, durable property: whatever `chooseMethod` picks, the provider can
 * actually honour it. A method a provider cannot serve is the bug class here.
 *
 * ## What this cannot see
 *
 * Half of the original bug was `optionsFor` sending `{ openai: {
 * structuredOutputs: … } }` — a key that does not exist in `@ai-sdk/openai`, so
 * the SDK dropped it silently and `tool` sent a request identical to
 * `constrained`. No schema measurement can observe that; only a live call can.
 * Recorded here rather than papered over: this gate closes the caps half.
 */

const PROVIDERS: readonly (readonly [string, GrammarCaps])[] = [
  ['anthropic', ANTHROPIC_CAPS],
  ['openai', OPENAI_CAPS],
  ['google', GEMINI_CAPS],
  ['deepseek', DEEPSEEK_CAPS],
];

/** The four schemas `engine/steps.ts` actually sends. */
const OPERATIONS = [
  ['analyze', UnderstandingDeltaCodec],
  ['assess', UnderstandingAssessment],
  ['analyze-and-assess', AnalyzeAndAssessResult],
  ['generate-questions', QuestionDrafts],
] as const;

const cells = PROVIDERS.flatMap(([provider, caps]) =>
  OPERATIONS.map(([operation, schema]) => ({ provider, caps, operation, schema })),
);

describe('every operation is servable by every provider', () => {
  it.each(cells)('$operation on $provider', ({ caps, schema }) => {
    const budget = budgetOf(schema);
    const choice = chooseMethod(budget, caps);

    // `constrained` is only legal when the provider has it *and* the schema
    // fits every one of its limits. OpenAI's `optional` limit is 0 — not a
    // branchiness budget but a format rule: strict mode requires `required` to
    // name every property. A cell that picks `constrained` over that limit is a
    // 400 waiting for someone to select that provider.
    if (choice.method !== 'constrained') return;

    expect(caps.supportsConstrained).toBe(true);
    expect(budget.optional).toBeLessThanOrEqual(caps.optional);
    expect(budget.union).toBeLessThanOrEqual(caps.union);
  });
});

describe('the caps table says what each provider really allows', () => {
  it('records that OpenAI permits no optional properties at all', () => {
    // Not a sentinel, unlike `supportsConstrained: false` on DeepSeek. OpenAI
    // *does* support constrained decoding; it permits exactly zero optional
    // properties, because strict mode requires `required` to list every key.
    // `20` was a guess carried over from a branchiness model that does not
    // apply, and it is what stopped the step-down from ever firing.
    expect(OPENAI_CAPS.supportsConstrained).toBe(true);
    expect(OPENAI_CAPS.optional).toBe(0);
  });

  it('keeps Anthropic and Google able to take an optional property', () => {
    // Measured, not assumed: both accepted the 1-optional `assess` schema in
    // constrained mode and returned valid output. This is what makes the
    // OpenAI cap a provider fact rather than a schema defect.
    expect(ANTHROPIC_CAPS.optional).toBeGreaterThan(0);
    expect(GEMINI_CAPS.optional).toBeGreaterThan(0);
  });
});

describe('what each cell resolves to, as a readable record', () => {
  it('prints the matrix', () => {
    const rows = OPERATIONS.map(([operation, schema]) => {
      const budget = budgetOf(schema);
      const byProvider = PROVIDERS.map(
        ([provider, caps]) => `${provider}=${chooseMethod(budget, caps).method}`,
      ).join('  ');
      return `${operation.padEnd(20)} opt=${budget.optional} union=${budget.union}   ${byProvider}`;
    });
    process.stdout.write(`\n[caps]\n  ${rows.join('\n  ')}\n\n`);

    // Pinned so the record cannot silently become empty.
    expect(rows).toHaveLength(OPERATIONS.length);
  });
});
