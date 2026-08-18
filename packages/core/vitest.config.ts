import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Unit tests must never reach a provider. Anything needing Postgres or a
    // real API belongs in *.integration.test.ts, run explicitly.
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
  },
});
