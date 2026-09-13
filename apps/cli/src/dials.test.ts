import { TEMPERAMENT_PRESETS } from '@requirely/core/domain';
import { describe, expect, it } from 'vitest';
import { temperamentFrom } from './dials.ts';

describe('dial flags', () => {
  it('means "let createSession decide" when nothing was given', () => {
    // Not the balanced vector: one place must own what "no dials" means, or the
    // CLI and the domain can disagree about the product's resting state.
    expect(temperamentFrom({})).toBeUndefined();
    expect(temperamentFrom({ title: 'Roomly', memory: true })).toBeUndefined();
  });

  it('resolves a preset by name', () => {
    expect(temperamentFrom({ dials: 'explorer' })).toEqual(TEMPERAMENT_PRESETS.explorer);
  });

  it('lets a dial override the preset it was given with', () => {
    // A preset is a starting point, not a mode — so this has to read the way it
    // looks: explorer, but plain language.
    const tuned = temperamentFrom({ dials: 'explorer', technicality: '0.1' });
    expect(tuned?.technicality).toBe(0.1);
    expect(tuned?.creativity).toBe(TEMPERAMENT_PRESETS.explorer.creativity);
  });

  it('accepts dials with no preset, leaving the rest neutral', () => {
    const tuned = temperamentFrom({ creativity: '0.9' });
    expect(tuned?.creativity).toBe(0.9);
    expect(tuned?.assertiveness).toBe(0.5);
  });

  it('names the flag when the value is not a number', () => {
    expect(() => temperamentFrom({ creativity: 'high' })).toThrow(
      /--creativity needs a number between 0 and 1, not "high"/,
    );
  });

  it('rejects a value outside the scale rather than clamping it', () => {
    // `--creativity 9` is someone who thinks the scale is 0..10, and clamping to
    // 1 would silently agree with them forever.
    // And says so in a sentence. `Temperament.parse` is the authority, but a
    // ZodError's `message` is a JSON dump of its issues and `main.ts` prints
    // `error.message` — so the readable version has to be produced here, where
    // the flag name is still known.
    expect(() => temperamentFrom({ creativity: '9' })).toThrow(
      /--creativity must be between 0 and 1, not 9/,
    );
    expect(() => temperamentFrom({ creativity: '-1' })).toThrow(/must be between 0 and 1/);
  });

  it('lists the presets when one is misspelled', () => {
    expect(() => temperamentFrom({ dials: 'explore' })).toThrow(/Unknown --dials "explore"/);
    expect(() => temperamentFrom({ dials: 'explore' })).toThrow(/explorer/);
  });
});
