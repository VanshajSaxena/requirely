import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',

    // Every test under src/ is hermetic and runs in the default gate. PGlite is
    // Postgres compiled to WASM, in-process — no socket, no Docker — and the AI
    // side is always `fakeStructuredGenerator`, which validates its scripted
    // responses against the real schema. There is deliberately no separate
    // integration tier: src/integration/ holds tests that wire adapters to the
    // engine, and they run like everything else.
    //
    // What keeps "no test reaches a provider" true is not this config. It is
    // scripts/check-boundaries.sh rule 4, plus the fact that no provider SDK is
    // installed at all.
    //
    // An earlier version excluded '**/*.integration.test.ts'. No file has ever
    // matched it — the tests live in src/integration/ and are not named
    // *.integration.test.ts — so it excluded nothing while implying otherwise.
    //
    // Spreading configDefaults.exclude is deliberate: supplying `exclude`
    // REPLACES vitest's defaults rather than extending them, so writing the list
    // by hand silently drops **/dist/** and friends.
    exclude: [...configDefaults.exclude],
  },
});
