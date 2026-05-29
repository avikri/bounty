/**
 * [C] Reject flow through the UI: the reject modal, reason entry, and the
 * rejection reason surfacing in the claimant's bounty detail + inbox. The CF
 * points/clamp logic (C3) is covered by the integration suite.
 */
import { test, expect, PERSONAS } from './fixtures/test';
import { signInAndVisit } from './helpers/auth';
import { loginSeedUser } from './fixtures/seed';
import { toPendingReview } from './helpers/flows';

test('[C1][P0] reject with a reason surfaces it on the claimant detail + inbox', async ({ page, seed }) => {
  const gid = seed.groupId;
  const a = await loginSeedUser(PERSONAS.A);
  const b = await loginSeedUser(PERSONAS.B);
  const bid = await toPendingReview(a, b, gid, { title: 'Blurry task' });
  await a.dispose(); await b.dispose();

  // A rejects with a reason via the review queue.
  await signInAndVisit(page, PERSONAS.A, '/reviews');
  const row = page.locator(`[data-testid="review-row"][data-bounty-id="${bid}"]`);
  await row.click();
  await page.getByTestId('reject').click();
  await expect(page.getByTestId('reject-modal')).toBeVisible();
  await page.getByTestId('reject-reason').fill('Photo is blurry.');
  await page.getByTestId('reject-confirm').click();
  await expect(row).toHaveCount(0); // rejection applied → leaves the queue

  // B sees the failed state + reason on the detail.
  await signInAndVisit(page, PERSONAS.B, `/g/${gid}/b/${bid}`);
  await expect(page.getByTestId('state-badge')).toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('rejection-reason')).toHaveText('Photo is blurry.');

  // …and a rejection notification carrying the reason.
  await page.goto('/inbox');
  const notif = page.locator('[data-testid="notif"][data-kind="bounty_rejected"]');
  await expect(notif).toBeVisible();
  await expect(notif).toContainText('Photo is blurry.');
});

test('[C2][P1] reject with a blank reason proceeds and shows no reason', async ({ page, seed }) => {
  const gid = seed.groupId;
  const a = await loginSeedUser(PERSONAS.A);
  const b = await loginSeedUser(PERSONAS.B);
  const bid = await toPendingReview(a, b, gid, { title: 'No reason task' });
  await a.dispose(); await b.dispose();

  await signInAndVisit(page, PERSONAS.A, '/reviews');
  const row = page.locator(`[data-testid="review-row"][data-bounty-id="${bid}"]`);
  await row.click();
  await page.getByTestId('reject').click();
  await page.getByTestId('reject-confirm').click(); // leave reason blank
  await expect(row).toHaveCount(0);

  await signInAndVisit(page, PERSONAS.B, `/g/${gid}/b/${bid}`);
  await expect(page.getByTestId('state-badge')).toHaveAttribute('data-state', 'failed');
  // No rejection-reason block is rendered when the reason is empty.
  await expect(page.getByTestId('rejection-reason')).toHaveCount(0);

  await page.goto('/inbox');
  const notif = page.locator('[data-testid="notif"][data-kind="bounty_rejected"]');
  await expect(notif).toBeVisible();
  await expect(notif).not.toContainText('Reason:');
});
