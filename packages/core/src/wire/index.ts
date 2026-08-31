/**
 * The wire layer: what a model sees, and the codec back to the domain.
 *
 * Depends on `domain/` and nothing else — not on `engine/`, not on `adapters/`.
 * That direction is enforced by `scripts/check-boundaries.sh`, because the whole
 * point of the layer collapses if a provider concern leaks in: the wire is
 * shaped by what *grammar compilers* can take, which is a fact about every
 * provider, not about one.
 */
export * from './budget.ts';
export * from './codec.ts';
export * from './delta.ts';
export * from './sentinel.ts';
