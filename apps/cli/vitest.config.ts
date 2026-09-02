import { defineConfig } from 'vitest/config';

/**
 * Per-package, matching `packages/core`. The CLI's tests run its commands
 * against in-memory stores and a scripted provider, so they need no setup —
 * but they do need a cwd of this package, which `pnpm --filter` guarantees and
 * a root-level run would not.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
