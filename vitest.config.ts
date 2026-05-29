import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit + integration only. E2E specs live in tests/e2e and run under
    // Playwright, not vitest — keep them out of this glob.
    include: ['tests/unit/**/*.spec.ts', 'tests/integration/**/*.spec.ts'],
    // Integration specs share a single emulator instance and clear data
    // between tests, so files must not run concurrently.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
