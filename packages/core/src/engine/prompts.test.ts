import { describe, expect, it } from 'vitest';
import { countsFor, TEMPERAMENT_PRESETS, type Temperament } from '../domain/index.ts';
import {
  ANALYZE_BODY,
  ASSESS_BODY,
  analyzeAndAssessInstructions,
  analyzeInstructions,
  assessInstructions,
  type Dialled,
  QUESTIONS_BODY,
  questionsInstructions,
} from './prompts.ts';

const dialled = (temperament: Temperament): Dialled => ({
  temperament,
  counts: countsFor(temperament, { maxQuestionsPerTurn: 4 }),
});

const { scribe, explorer, translator } = TEMPERAMENT_PRESETS;

const OPERATIONS = [
  { name: 'analyze', body: ANALYZE_BODY, render: analyzeInstructions },
  { name: 'assess', body: ASSESS_BODY, render: assessInstructions },
  { name: 'questions', body: QUESTIONS_BODY, render: questionsInstructions },
] as const;

describe('the stable body stays a prefix', () => {
  /**
   * **This is the prompt-caching claim, as a test.**
   *
   * `adapters/ai/vercel.ts` sends these as the system prompt and says they are
   * "stable per operation … so providers that cache on a system prefix can do
   * so". Dials are per session, so a briefing at the *front* would give every
   * session its own cache key and nothing would fail — the cost would just
   * quietly appear on the bill. Appending keeps the shared prefix intact.
   */
  it.each(OPERATIONS)('$name begins with its unvaried body', ({ body, render }) => {
    for (const temperament of [scribe, explorer, translator]) {
      expect(render(dialled(temperament)).startsWith(body)).toBe(true);
    }
  });

  it('keeps the merged operation on the same footing', () => {
    const merged = analyzeAndAssessInstructions(dialled(explorer));
    expect(merged.startsWith(ANALYZE_BODY)).toBe(true);
    expect(merged).toContain(ASSESS_BODY);
  });
});

describe('the dials reach every operation', () => {
  // The placebo test at the prompt level. `temperament.test.ts` proves the
  // briefing varies; this proves the prompts actually carry it.
  it.each(OPERATIONS)('$name differs between scribe and explorer', ({ render }) => {
    expect(render(dialled(scribe))).not.toBe(render(dialled(explorer)));
  });

  it('tells each operation only about the dials it can act on', () => {
    // `analyze` has no questions to ask. Sending it `curiosity` would dilute the
    // instructions that matter, which costs more than the tokens do.
    const analyze = analyzeInstructions(dialled(explorer));
    expect(analyze).toContain('creativity —');
    expect(analyze).not.toContain('curiosity —');

    const assess = assessInstructions(dialled(explorer));
    expect(assess).toContain('thoroughness —');
    expect(assess).not.toContain('creativity —');

    const questions = questionsInstructions(dialled(explorer));
    expect(questions).toContain('curiosity —');
    expect(questions).not.toContain('thoroughness —');
  });

  it('separates the two personas on the words, not the ambition', () => {
    // The product claim, as a test: both get the same licence to infer, and
    // opposite instructions about vocabulary.
    const forExplorer = analyzeInstructions(dialled(explorer));
    const forTranslator = analyzeInstructions(dialled(translator));

    expect(forExplorer).toContain('Treat every input as under-determined');
    expect(forTranslator).toContain('Treat every input as under-determined');
    expect(forTranslator).toContain('No jargon at all');
    expect(forExplorer).not.toContain('No jargon at all');
  });
});

describe('what was deliberately removed', () => {
  /**
   * These three sentences were the interrogatory behaviour, written down. They
   * are gone from the body and survive only as the bottom band of a dial, where
   * `scribe` still reaches them.
   */
  it('no longer hard-codes conservatism into every session', () => {
    expect(ANALYZE_BODY).not.toContain('LAST RESORT');
    expect(ANALYZE_BODY).not.toContain('Be conservative');
    expect(ANALYZE_BODY).not.toContain('Inventing requirements nobody asked for');
  });

  it('still reaches that position at the bottom of the dial', () => {
    // Removing it from the body must not remove it from the product: someone
    // who genuinely has a spec and wants it transcribed should still get this.
    expect(analyzeInstructions(dialled(scribe))).toContain('a last resort');
    expect(analyzeInstructions(dialled(explorer))).toContain('**not** a last resort');
  });

  it('says "not a question-asking machine" once, not twice', () => {
    // It appeared at the top *and* the bottom of the old prompt and changed
    // nothing — repetition is not leverage. One copy is fine; two was a signal
    // that someone was trying to fix a structural problem with emphasis.
    // Whitespace-normalised first: the prompt is hard-wrapped prose, so the
    // phrase spans a line break and a naive search finds zero. A test that
    // breaks when someone re-wraps a paragraph is worse than no test.
    const flat = QUESTIONS_BODY.replace(/\s+/g, ' ');
    expect(flat.split('already thought the problem through')).toHaveLength(2);
  });

  it('asks the model to assume the user does not know the answer', () => {
    // The persona insight, stated where it can act: recognition beats recall.
    expect(QUESTIONS_BODY).toContain('Assume the user does not already know the answer');
  });
});
