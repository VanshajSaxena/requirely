import {
  DIAL_NAMES,
  TEMPERAMENT_PRESET_NAMES,
  TEMPERAMENT_PRESETS,
  type Temperament,
  Temperament as TemperamentSchema,
} from '@requirely/core/domain';

/**
 * Turning dial flags into a `Temperament`.
 *
 * Its own module rather than a function in `main.ts` for one reason: `main.ts`
 * calls `main()` at import time, so anything living there can only be tested by
 * spawning a process. Argument interpretation is real logic — a preset name, five
 * optional overrides, and a precedence rule between them — and it should be
 * testable without one.
 */

/**
 * Dial flags to a `Temperament`, or `undefined` when the user set none.
 *
 * `undefined` rather than the balanced vector on purpose: it lets
 * `createSession` own the default, so there is one place that decides what "no
 * dials given" means rather than two that could disagree.
 *
 * Validation is the domain's — `Temperament.parse` rejects anything outside
 * 0..1 rather than clamping, because a clamp silently accepts a caller who has
 * misunderstood the scale. This function only turns strings into numbers and
 * fails with a message naming the flag, which argv parsing is the only layer
 * that can do.
 */
export function temperamentFrom(
  values: Record<string, string | boolean | undefined>,
): Temperament | undefined {
  const preset = values.dials as string | undefined;
  const overrides: Record<string, number> = {};

  for (const dial of DIAL_NAMES) {
    const raw = values[dial] as string | undefined;
    if (raw === undefined) continue;
    const parsed = Number.parseFloat(raw);
    if (Number.isNaN(parsed)) {
      throw new Error(`--${dial} needs a number between 0 and 1, not "${raw}".`);
    }
    // Range-checked here, with the flag name in hand, rather than left to
    // `Temperament.parse`. A ZodError's `message` is a JSON dump of its issues,
    // and `main.ts` prints `error.message` — so the backstop alone produced a
    // twelve-line array where the user needed one sentence. The schema is still
    // the authority; this is the layer that can say which flag was wrong.
    if (parsed < 0 || parsed > 1) {
      throw new Error(
        `--${dial} must be between 0 and 1, not ${raw}. The dials are a 0-to-1 scale, so 0.9 is "a lot" and 9 is not a setting.`,
      );
    }
    overrides[dial] = parsed;
  }

  if (preset === undefined && Object.keys(overrides).length === 0) return undefined;

  if (preset !== undefined && !TEMPERAMENT_PRESET_NAMES.includes(preset as never)) {
    throw new Error(`Unknown --dials "${preset}". Try: ${TEMPERAMENT_PRESET_NAMES.join(', ')}.`);
  }

  // Overrides last, so `--dials explorer --technicality 0.1` means what it reads
  // like. A preset is a starting point, not a mode.
  const base =
    preset === undefined ? {} : TEMPERAMENT_PRESETS[preset as keyof typeof TEMPERAMENT_PRESETS];
  return TemperamentSchema.parse({ ...base, ...overrides });
}
