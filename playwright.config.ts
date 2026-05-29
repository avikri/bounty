import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E config for the Bounty app.
 *
 * The suite is launched by `npm run test:e2e`, which wraps Playwright in
 * `firebase emulators:exec` so the Auth/Firestore/Functions/Storage emulators
 * are up for the whole run. Playwright in turn boots the Angular dev server in
 * its `e2e` configuration (`environment.e2e.ts` → `useEmulators: true`), which
 * points the app at those emulators and installs the test-only `window.__e2e`
 * sign-in hook.
 *
 * Tests share one emulator and reset+reseed Firestore/Auth per test (see
 * tests/e2e/fixtures), so they must run serially — mirrors the integration
 * layer's `fileParallelism: false`.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:4300',
    trace: 'on-first-retry',
    // The proof-gallery and lightbox load images from the Storage emulator;
    // ignore self-signed/locahost cert quirks just in case.
    ignoreHTTPSErrors: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run e2e:serve',
    url: 'http://localhost:4300',
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
