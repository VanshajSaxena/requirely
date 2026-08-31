import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnvFile } from '../../config/env.ts';

/**
 * Is the constrained-decoding budget spent **per schema** or **per request**?
 *
 * It decides the whole remedy. Measured offline, every collection of
 * `UnderstandingDelta` fits both limits on its own (worst is `requirements` at
 * 16 optional / 8 union, against 24 / 16); the delta only fails as their sum.
 * So if the budget is per schema, splitting one big schema into several small
 * tools recovers constrained decoding **in a single request** and the domain
 * needs no change at all. If it is per request, splitting buys nothing unless
 * the requests are also split — which multiplies cost per turn.
 *
 * Raw HTTP rather than the AI SDK, deliberately: the question is about the
 * provider's own accounting, and a provider abstraction in the middle is one
 * more thing that could be shaping the payload.
 */

const LIVE = process.env.REQUIRELY_LIVE === '1';
const MODEL = process.env.REQUIRELY_LIVE_MODEL ?? 'claude-haiku-4-5';

/** A tool with `count` optional string properties — the thing the limit counts. */
const toolWith = (name: string, count: number, strict: boolean) => ({
  name,
  description: `probe tool ${name}`,
  input_schema: {
    type: 'object',
    properties: Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`field_${i}`, { type: 'string' }]),
    ),
    required: [],
    additionalProperties: false,
  },
  ...(strict ? { strict: true } : {}),
});

const send = (tools: unknown[]) => sendRaw({ tools });

async function sendRaw(
  extra: Record<string, unknown>,
): Promise<{ status: number; message: string }> {
  loadEnvFile(join(import.meta.dirname, '../../../../../.env'));
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2_048,
      messages: [{ role: 'user', content: 'Say hi. Do not call any tool.' }],
      ...extra,
    }),
  });
  const body = (await response.json()) as { error?: { message?: string } };
  return { status: response.status, message: body.error?.message ?? 'accepted' };
}

describe.skipIf(!LIVE)('where the constrained-decoding budget is spent', () => {
  it('reports whether two 15-optional tools (30 total) are counted together', async () => {
    // 15 is under the 24 limit; 30 is over it. One tool must pass. If two also
    // pass, the budget is per schema; if they fail naming 30, it is per request.
    const one = await send([toolWith('probe_a', 15, true)]);
    const two = await send([toolWith('probe_a', 15, true), toolWith('probe_b', 15, true)]);

    console.info(`[budget] 1 strict tool  x 15 optional -> ${one.status} ${one.message}`);
    console.info(`[budget] 2 strict tools x 15 optional -> ${two.status} ${two.message}`);

    const oversized = await send([toolWith('probe_big', 30, true)]);
    console.info(
      `[budget] 1 strict tool  x 30 optional -> ${oversized.status} ${oversized.message}`,
    );

    const loose = await send([toolWith('probe_loose', 30, false)]);
    console.info(`[budget] 1 NON-strict tool x 30 optional -> ${loose.status} ${loose.message}`);

    // No assertion on the outcome — this probe exists to *find out*, and either
    // answer is a legitimate architectural fact. The console lines are the result.
    expect(one.status).toBeGreaterThan(0);
  }, 120_000);

  it('reports whether thinking survives an unforced tool choice', async () => {
    // The reason `analyze` currently runs without thinking is not the schema —
    // it is that `generateObject` forces `tool_choice`, and Anthropic rejects
    // thinking alongside a forced tool. If an *unforced* choice is accepted, the
    // loss is recoverable: hand the model one tool, let it decide, and keep
    // thinking. If not, the loss is structural.
    const tool = toolWith('emit_delta', 30, false);
    const thinking = { type: 'enabled', budget_tokens: 1_024 };

    const forced = await sendRaw({
      tools: [tool],
      tool_choice: { type: 'tool', name: 'emit_delta' },
      thinking,
    });
    const auto = await sendRaw({ tools: [tool], tool_choice: { type: 'auto' }, thinking });
    const any = await sendRaw({ tools: [tool], tool_choice: { type: 'any' }, thinking });

    console.info(`[thinking] forced tool_choice + thinking -> ${forced.status} ${forced.message}`);
    console.info(`[thinking] auto   tool_choice + thinking -> ${auto.status} ${auto.message}`);
    console.info(`[thinking] any    tool_choice + thinking -> ${any.status} ${any.message}`);

    expect(forced.status).toBeGreaterThan(0);
  }, 120_000);
});
