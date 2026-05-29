/**
 * [J] Auth & routing in the browser: the guard redirect (with return path),
 * public routes, unknown-route fallback, and session persistence across reload.
 */
import { test, expect, PERSONAS } from './fixtures/test';
import { signInAndVisit } from './helpers/auth';

test('[J1][P1] a signed-out visit to a protected route redirects to /login with a return path', async ({ page }) => {
  await page.goto('/groups');
  await expect(page).toHaveURL(/\/login\?redirect=%2Fgroups/);
  await expect(page.getByTestId('login-page')).toBeVisible();
});

test('[J2][P1] /login and /join/:code are reachable while signed out', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByTestId('login-page')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  await page.goto('/join/ABCDEF');
  await expect(page.getByTestId('join-page')).toBeVisible();
  await expect(page).toHaveURL(/\/join\/ABCDEF$/); // not bounced to /login
});

test('[J3][P2] an unknown route falls back to /groups', async ({ page, seed }) => {
  void seed;
  await signInAndVisit(page, PERSONAS.A, '/groups');
  await page.goto('/this-route-does-not-exist');
  await expect(page).toHaveURL(/\/groups$/);
});

test('[J4][P2] the session persists across a reload', async ({ page, seed }) => {
  void seed;
  await signInAndVisit(page, PERSONAS.A, '/groups');
  await expect(page.getByTestId('group-card')).toBeVisible();

  await page.reload();
  // Still authenticated: no bounce to /login, group list still rendered.
  await expect(page).toHaveURL(/\/groups$/);
  await expect(page.getByTestId('login-page')).toHaveCount(0);
  await expect(page.getByTestId('group-card')).toBeVisible();
});
