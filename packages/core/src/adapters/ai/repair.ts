/**
 * Getting a JSON value out of ordinary model prose.
 *
 * Only `prompted` generation needs this: the other two methods hand back an
 * already-parsed object. It is a **ladder, not a flag** — each rung is tried in
 * order, costs nothing, and *reports what it did*, so a value that took three
 * repairs is distinguishable from one that arrived clean. Without that record,
 * "prompted mode works fine" is unfalsifiable.
 *
 * The rungs are deliberately conservative. Aggressive JSON repair — inserting
 * missing braces, quoting bare keys, guessing at truncation — turns a loud
 * failure into a quiet wrong answer, and a wrong requirement is worse than a
 * retry. Everything here either succeeds exactly or leaves the input alone.
 *
 * A rung that cannot fix the value is not a failure; it just does not apply.
 * Failure is the whole ladder ending with nothing that parses, which becomes a
 * retryable `CapabilityError` and one more attempt.
 */

export interface RepairResult {
  /** The parsed value, or `null` if nothing on the ladder produced one. */
  readonly value: unknown;
  /** Which rungs did something, in order. Empty when the raw text parsed as-is. */
  readonly repairs: readonly string[];
  readonly ok: boolean;
}

const tryParse = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

/**
 * Rung 1 — strip everything that is not the JSON value.
 *
 * Covers the two things models actually do: wrap the answer in a ```json fence,
 * and top-and-tail it with "Here is the delta:" / "Let me know if…".
 *
 * **Balance is not enough, and the first version of this was wrong because of
 * it.** Scanning to the first balanced `{…}` returns `{curly}` from the sentence
 * "use {curly} braces" — balanced, and not JSON. So every balanced span is
 * collected and only the ones that actually `JSON.parse` are candidates, with
 * the **longest** winning: prose can contain `{}`, which parses fine and is
 * never the answer.
 *
 * A candidate counts as JSON if it parses **or** parses once trailing commas are
 * stripped. Without that second clause this rung would reject exactly the input
 * rung 2 exists to fix, and rung 2 would never run — which is what happened the
 * first time, caught by its own test.
 *
 * Quadratic in the number of opening brackets, which is bounded by a model
 * reply and has never been near a problem. Say so rather than optimizing a cost
 * nobody has measured.
 */
export function extractJson(text: string): string | null {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(text);
  const body = fenced?.[1] ?? text;

  let best: string | null = null;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char !== '{' && char !== '[') continue;
    const span = balancedSpan(body, i);
    if (span === null) continue;
    if (best !== null && span.length <= best.length) continue;
    // Balanced but unparseable means prose — a template literal, set notation,
    // `{curly}` in a sentence. The raw span is kept rather than the repaired
    // one so rung 2 still gets to run and report what it did.
    if (isJsonish(span)) best = span;
  }
  return best;
}

const parses = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

const isJsonish = (span: string): boolean => parses(span) || parses(stripTrailingCommas(span));

/**
 * The balanced span starting at `start`, or null if it never closes.
 *
 * Truncation is deliberately **not** repaired by appending closers: a cut-off
 * list of requirements would silently become a shorter list that looks complete,
 * and a shorter list is indistinguishable from a correct one downstream.
 */
function balancedSpan(text: string, start: number): string | null {
  const opener = text[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Rung 2 — remove trailing commas.
 *
 * The one syntax error worth fixing: it is unambiguous, it changes no value, and
 * models produce it constantly because most languages allow it. String contents
 * are skipped, so a comma inside a quoted requirement is never touched.
 */
export function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      out += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      out += char;
      continue;
    }
    if (!inString && char === ',') {
      const rest = text.slice(i + 1);
      const next = /^\s*([}\]])/.exec(rest);
      if (next !== null) continue;
    }
    out += char;
  }
  return out;
}

/**
 * Rung 3 — unwrap a single-key envelope.
 *
 * Models wrap answers: `{"delta": {...}}`, `{"result": {...}}`, `{"output": …}`.
 * Safe because it is only attempted *after* the outer value failed validation,
 * and only when there is exactly one key — so there is no choice to get wrong.
 */
export function unwrapEnvelope(value: unknown): unknown | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1) return null;
  const inner = (value as Record<string, unknown>)[keys[0] as string];
  return inner !== null && typeof inner === 'object' ? inner : null;
}

/**
 * Runs the ladder, stopping at the first rung that yields a value `validate`
 * accepts.
 *
 * `validate` is passed in rather than a schema so this file stays free of Zod
 * and of any knowledge of what is being parsed — the caller already holds the
 * schema, and keeping the ladder ignorant of it is what makes every rung
 * unit-testable in isolation.
 */
export function repairToValid(
  text: string,
  validate: (candidate: unknown) => boolean,
): RepairResult {
  const repairs: string[] = [];

  const attempt = (candidate: unknown): RepairResult | null =>
    validate(candidate) ? { value: candidate, repairs: [...repairs], ok: true } : null;

  const direct = tryParse(text);
  if (direct.ok) {
    const clean = attempt(direct.value);
    if (clean !== null) return clean;
  }

  const extracted = extractJson(text);
  if (extracted === null) return { value: null, repairs, ok: false };
  if (extracted !== text.trim()) repairs.push('extracted the JSON value from surrounding text');

  let parsed = tryParse(extracted);
  if (!parsed.ok) {
    const stripped = stripTrailingCommas(extracted);
    if (stripped !== extracted) {
      parsed = tryParse(stripped);
      if (parsed.ok) repairs.push('removed trailing commas');
    }
  }
  if (!parsed.ok) return { value: null, repairs, ok: false };

  const asIs = attempt(parsed.value);
  if (asIs !== null) return asIs;

  const inner = unwrapEnvelope(parsed.value);
  if (inner !== null) {
    repairs.push('unwrapped a single-key envelope');
    const unwrapped = attempt(inner);
    if (unwrapped !== null) return unwrapped;
  }

  return { value: parsed.value, repairs, ok: false };
}
