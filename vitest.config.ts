import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'scripts/*.test.ts'],
    // The full-application test launches Electron and needs a display, so it is
    // opt-in via `npm run test:app` rather than part of the default run.
    exclude: ['**/node_modules/**', '**/*.e2e.test.ts'],
    testTimeout: 90_000
  }
})
