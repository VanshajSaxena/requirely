import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { measureBudget } from '../../wire/budget.ts';
import { UnderstandingDeltaCodec } from '../../wire/index.ts';
import { chooseMethod, type GrammarCaps, methodFor } from './method.ts';

/**
 * The one genuinely novel piece: deciding how to ask, per request, from a
 * measurement. Pure, so all of it is testable with no key and no network.
 */

const ANTHROPIC: GrammarCaps = {
  supportsConstrained: true,
  optional: 24,
  union: 16,
  toolModeForbidsThinking: true,
};
const OPENAI: GrammarCaps = {
  supportsConstrained: true,
  optional: 20,
  union: 12,
  toolModeForbidsThinking: false,
};

const budget = (optional: number, union: number) => ({ optional, union, bytes: 1000 });

describe('chooseMethod', () => {
  it('prefers the strongest guarantee a schema fits inside', () => {
    expect(chooseMethod(budget(0, 0), ANTHROPIC).method).toBe('constrained');
    expect(chooseMethod(budget(24, 16), ANTHROPIC).method).toBe('constrained');
  });

  it('steps down to a tool when the schema is too branchy to compile', () => {
    expect(chooseMethod(budget(25, 0), ANTHROPIC).method).toBe('tool');
    expect(chooseMethod(budget(0, 17), ANTHROPIC).method).toBe('tool');
  });

  it('counts unions against the tighter budget, which is why nullable is not the fix', () => {
    // 20 optionals is fine, 20 unions is not. Making every optional field
    // `required` and nullable would move spend from the looser budget into the
    // tighter one and fail harder — the reflex fix, measured.
    expect(chooseMethod(budget(20, 0), ANTHROPIC).method).toBe('constrained');
    expect(chooseMethod(budget(0, 20), ANTHROPIC).method).toBe('tool');
  });

  it('skips tool mode for a high-effort call when tool mode would disable thinking', () => {
    // Anthropic's `jsonTool` forces tool_choice, and forced tool use rejects
    // extended thinking. On a high-effort operation that trades away the
    // deliberation that made it high-effort — so `prompted` is the better step.
    const choice = chooseMethod(budget(50, 0), ANTHROPIC, true);
    expect(choice.method).toBe('prompted');
    expect(choice.reason).toContain('thinking');
  });

  it('keeps tool mode for a high-effort call on a provider that allows thinking there', () => {
    // The same input, one cap different. This is the case that shows the rule is
    // reading a provider capability rather than hard-coding Anthropic.
    expect(chooseMethod(budget(50, 0), OPENAI, true).method).toBe('tool');
  });

  it('explains every choice, so a surprising mode is never a mystery', () => {
    expect(chooseMethod(budget(0, 0), ANTHROPIC).reason).toContain('fits');
    expect(chooseMethod(budget(99, 0), ANTHROPIC).reason).toContain('limit 24');
    expect(chooseMethod(budget(0, 99), ANTHROPIC).reason).toContain('limit 16');
  });

  it('names both limits when a schema breaks both', () => {
    const reason = chooseMethod(budget(99, 99), ANTHROPIC).reason;
    expect(reason).toContain('optional');
    expect(reason).toContain('unions');
  });
});

describe('methodFor — measurement plus decision', () => {
  it('sends the wire delta constrained, which is what the codec was for', () => {
    // Before `src/wire/`, the domain delta measured 84/34 and this was forced to
    // `tool` — which on Anthropic also disabled thinking on the one call whose
    // effort is `high`. Asserting the mode here is asserting that Step 2 held.
    expect(methodFor(UnderstandingDeltaCodec, ANTHROPIC, true).method).toBe('constrained');
  });

  it('would step down if a schema ever grew past the caps', () => {
    // A negative control: without it, the assertion above could be passing
    // because the decision is stuck rather than because the schema is small.
    const branchy = z.object(
      Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`f${i}`, z.string().optional()]),
      ) as Record<string, z.ZodOptional<z.ZodString>>,
    );
    expect(measureBudget(branchy).optional).toBe(40);
    expect(methodFor(branchy, ANTHROPIC).method).toBe('tool');
  });
});

describe('a provider with no constrained decoding at all', () => {
  /**
   * **The hole DeepSeek found.** `GrammarCaps` carried only two numbers, and they
   * measure *how branchy* a schema may be — which cannot express *never*. Since
   * the Phase 8 wire redesign `analyze` measures 0 optional / 0 union, so every
   * cap is satisfied and `constrained` would be chosen for a provider that
   * supports JSON mode but not JSON schema. The schema being good is what would
   * have caused the failure.
   */
  const NO_GRAMMAR = {
    supportsConstrained: false,
    optional: 20,
    union: 12,
    toolModeForbidsThinking: false,
  };

  it('never chooses constrained, even for a schema that fits every number', () => {
    const choice = chooseMethod({ optional: 0, union: 0, bytes: 100 }, NO_GRAMMAR);
    expect(choice.method).not.toBe('constrained');
    expect(choice.reason).toContain('no schema-constrained decoding');
  });

  it('steps down to tool, since tool mode is available and permits thinking', () => {
    expect(chooseMethod({ optional: 0, union: 0, bytes: 100 }, NO_GRAMMAR, true).method).toBe(
      'tool',
    );
  });
});
