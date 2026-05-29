/**
 * Shared Playwright test harness. The `seed` fixture wipes the emulators and
 * rebuilds the standard group state (A owns; B+C joined; C admin; D outside)
 * before each test that requests it — mirroring the integration layer's
 * reset-per-test discipline. Tests run serially (workers: 1) since they share
 * one emulator.
 */
import { test as base } from '@playwright/test';
import { SeededGroup, resetData, seedStandardGroup } from './seed';
import { disposeAdmin } from './admin';

export const test = base.extend<{ seed: SeededGroup }>({
  seed: async ({}, use) => {
    await resetData();
    const fixture = await seedStandardGroup();
    await use(fixture);
    await disposeAdmin();
  },
});

export { expect } from '@playwright/test';
export { PERSONAS } from './seed';
