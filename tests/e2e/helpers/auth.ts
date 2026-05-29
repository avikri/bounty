/**
 * Browser sign-in for E2E, using the emulator-only `window.__e2e` hook
 * (app.config.ts). The real login UI only offers Google/Apple OAuth popups,
 * which can't run headless, so specs authenticate programmatically against the
 * Auth emulator with seeded email/password personas. OAuth itself is out of
 * scope and verified manually (see tests/e2e/README.md).
 */
import { Browser, Page, expect } from '@playwright/test';
import { Persona } from '../fixtures/seed';

/** Sign in the given page as `persona` via the test hook. Leaves you on /login. */
export async function signIn(page: Page, persona: Persona): Promise<void> {
  await page.goto('/login');
  await page.waitForFunction(() => !!(window as unknown as { __e2e?: unknown }).__e2e);
  await page.evaluate(
    async (creds) => {
      await (window as unknown as {
        __e2e: { signIn(e: string, p: string): Promise<unknown> };
      }).__e2e.signIn(creds.email, creds.password);
    },
    { email: persona.email, password: persona.password },
  );
  await page.waitForFunction(
    () => !!(window as unknown as { __e2e: { uid(): string | null } }).__e2e.uid(),
  );
}

/** Sign in then navigate to `path` (full reload — also exercises auth persistence). */
export async function signInAndVisit(page: Page, persona: Persona, path = '/groups'): Promise<void> {
  await signIn(page, persona);
  await page.goto(path);
}

/** Sign out via the test hook. */
export async function signOut(page: Page): Promise<void> {
  await page.evaluate(
    () => (window as unknown as { __e2e: { signOut(): Promise<unknown> } }).__e2e.signOut(),
  );
}

/** Open a fresh browser context already signed in as `persona`, on `path`. */
export async function newSignedInPage(
  browser: Browser,
  persona: Persona,
  path = '/groups',
): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInAndVisit(page, persona, path);
  return page;
}

/** Convenience: assert we ended up on a path (after redirects settle). */
export async function expectPath(page: Page, re: RegExp): Promise<void> {
  await expect(page).toHaveURL(re);
}
