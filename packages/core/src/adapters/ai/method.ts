import type { z } from 'zod';
import type { GenerationMethod } from '../../domain/index.ts';
import { budgetOf, type SchemaBudget } from '../../wire/budget.ts';

/**
 * Choosing how to ask, per request, by measuring the schema against the
 * provider's limits.
 *
 * **No library does this.** Instructor, BAML and the AI SDK all take the mode as
 * configuration: you decide once, globally, whether to use structured output,
 * and a schema that turns out too branchy fails at request time with a message
 * about grammar compilation. That is a fine default when your schemas are small
 * and a bad one here, where `analyze` and `assess` differ by an order of
 * magnitude and the right answer differs with them.
 *
 * The decision is a **pure function of a measurement and a table of caps**, which
 * is what makes it testable without a network call and auditable after the fact:
 * every choice carries the `reason` that produced it.
 *
 * ## Why the order is constrained → tool → prompted
 *
 * Each step down trades a guarantee for reach.
 *
 * `constrained` makes malformed output unrepresentable, so it is preferred
 * wherever it fits. `tool` removes the size limit and hands conformance back to
 * us — recoverable, because `withValidationRetry` exists, but not free, and on
 * some providers it also forbids extended thinking. `prompted` assumes nothing
 * about the provider at all.
 *
 * [JSONSchemaBench] measured 10k real schemas: the best open-source constrained
 * engine compiles ~60% of the hard ones and OpenAI's structured outputs 6–13%.
 * **What that settles is expressiveness, not quality** — whether constrained
 * decoding helps or hurts accuracy is genuinely unsettled, with BAML's benchmarks
 * saying one thing and JSONSchemaBench's the other, both self-published. So this
 * ladder is ordered by *guarantee*, and Step 6's evals measure the quality
 * question rather than assuming it.
 *
 * [JSONSchemaBench]: https://arxiv.org/html/2501.10868v3
 */

/** What a provider will accept in a grammar-compiled schema. */
export interface GrammarCaps {
  readonly optional: number;
  readonly union: number;
  /**
   * Whether this provider's non-strict tool mode forbids extended thinking.
   *
   * Anthropic's does — `jsonTool` forces `tool_choice`, and *"Thinking may not be
   * enabled when tool_choice forces tool use."* That makes `tool` strictly worse
   * than `prompted` for a high-effort operation, which is the one case where the
   * ladder is not simply ordered by guarantee.
   */
  readonly toolModeForbidsThinking: boolean;
}

export interface MethodChoice {
  readonly method: GenerationMethod;
  /** Why, in one line. Logged and reported, so a surprising mode is explicable. */
  readonly reason: string;
  readonly budget: SchemaBudget;
}

/**
 * Picks a method for one schema.
 *
 * `prefersThinking` is the domain's `effort` reaching this decision without
 * naming a vendor: a `high`-effort operation on a provider whose tool mode
 * disables thinking is better served by `prompted`, because losing deliberation
 * on contradiction detection costs more than losing a decoding guarantee.
 */
export function chooseMethod(
  budget: SchemaBudget,
  caps: GrammarCaps,
  prefersThinking = false,
): MethodChoice {
  const over: string[] = [];
  if (budget.optional > caps.optional) {
    over.push(`${budget.optional} optional properties (limit ${caps.optional})`);
  }
  if (budget.union > caps.union) {
    over.push(`${budget.union} unions (limit ${caps.union})`);
  }

  if (over.length === 0) {
    return {
      method: 'constrained',
      reason: `schema fits the grammar caps (${budget.optional} optional, ${budget.union} union)`,
      budget,
    };
  }

  if (prefersThinking && caps.toolModeForbidsThinking) {
    return {
      method: 'prompted',
      reason: `${over.join(' and ')}; tool mode would disable thinking on a high-effort call`,
      budget,
    };
  }

  return { method: 'tool', reason: `${over.join(' and ')}`, budget };
}

/** Convenience for adapters: measure and choose in one step, with the measurement cached. */
export function methodFor(
  schema: z.ZodType<unknown>,
  caps: GrammarCaps,
  prefersThinking = false,
): MethodChoice {
  return chooseMethod(budgetOf(schema), caps, prefersThinking);
}
