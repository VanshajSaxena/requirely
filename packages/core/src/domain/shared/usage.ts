import { z } from 'zod';
import { OperationSchema } from './operation.ts';

/**
 * Every port returns usage. Capturing it at the capability boundary rather than
 * at each call site is what makes per-session cost accounting possible later
 * without touching engine code.
 *
 * `costMinorUnits` is nullable rather than optional because usage is stored as
 * JSONB — `null` survives a JSON round-trip, `undefined` does not.
 */
export const Usage = z.object({
  /** Which engine step spent this. Null for calls made outside a named operation. */
  operation: OperationSchema.nullable().default(null),
  provider: z.string().min(1),
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costMinorUnits: z.number().nonnegative().nullable().default(null),
});
export type Usage = z.infer<typeof Usage>;

export interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** null when no entry reported a cost — distinct from a genuine zero. */
  readonly costMinorUnits: number | null;
}

export function sumUsage(entries: readonly Usage[]): UsageTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cost: number | null = null;

  for (const entry of entries) {
    inputTokens += entry.inputTokens;
    outputTokens += entry.outputTokens;
    if (entry.costMinorUnits !== null) {
      cost = (cost ?? 0) + entry.costMinorUnits;
    }
  }

  return { inputTokens, outputTokens, costMinorUnits: cost };
}
