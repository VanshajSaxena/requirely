/**
 * The domain's public surface.
 *
 * `testing/fakes.ts` is deliberately absent: test doubles are importable by
 * anything that wants them, but they should never arrive by accident through
 * the main entry point.
 */

export * from './inquiry/answer.ts';
export * from './inquiry/drafts.ts';
export * from './inquiry/question.ts';
export * from './inquiry/validate-answer.ts';
export * from './ports/clock.ts';
export * from './ports/document-extractor.ts';
export * from './ports/embedder.ts';
export * from './ports/generation.ts';
export * from './ports/id-generator.ts';
export * from './ports/repositories.ts';
export * from './ports/structured-generator.ts';
export * from './ports/text-generator.ts';
export * from './ports/transcriber.ts';
export * from './session/session.ts';
export * from './shared/errors.ts';
export * from './shared/ids.ts';
export * from './shared/operation.ts';
export * from './shared/provenance.ts';
export * from './shared/time.ts';
export * from './shared/usage.ts';
export * from './source/source.ts';
export * from './sufficiency/coverage.ts';
export * from './sufficiency/policy.ts';
export * from './sufficiency/progress.ts';
export * from './sufficiency/verdict.ts';
export * from './temperament/briefing.ts';
export * from './temperament/derive.ts';
export * from './temperament/temperament.ts';
export * from './turn/commit.ts';
export * from './turn/turn.ts';
export * from './understanding/apply-delta.ts';
export * from './understanding/delta.ts';
export * from './understanding/drafts.ts';
export * from './understanding/understanding.ts';
