/**
 * [A] Full happy-path loop, driven through the real UI across two browser
 * contexts (A = poster/owner, B = claimant/member). The Cloud Functions logic
 * is already covered by the integration suite; here we exercise the UI and the
 * real-time onSnapshot propagation between the two sessions.
 */
import { test, expect, PERSONAS } from './fixtures/test';
import { signInAndVisit } from './helpers/auth';
import { Page } from '@playwright/test';

function card(page: Page, bid: string) {
  return page.locator(`[data-testid="bounty-card"][data-bounty-id="${bid}"]`);
}

test('[A1-A5][P0] post → claim → submit → approve → settle, with live updates', async ({ browser, seed }) => {
  const gid = seed.groupId;

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await signInAndVisit(pageA, PERSONAS.A, `/g/${gid}`);
  await signInAndVisit(pageB, PERSONAS.B, `/g/${gid}`);

  // ── A1: A posts a bounty ──────────────────────────────────────────────
  await expect(pageA.getByTestId('count-available')).toHaveText('0');
  await pageA.goto(`/g/${gid}/new`);
  await pageA.getByTestId('bounty-title').fill('Clean the whiteboard');
  await pageA.getByTestId('bounty-price').fill('25');
  await pageA.getByTestId('submit-bounty').click();
  await pageA.waitForURL(/\/g\/[^/]+\/b\/[^/]+$/);
  const bid = pageA.url().match(/\/b\/([^/?#]+)/)![1]!;

  // Available badge on the detail, and the feed count incremented.
  await expect(pageA.getByTestId('state-badge')).toHaveAttribute('data-state', 'available');
  await pageA.goto(`/g/${gid}`);
  await expect(pageA.getByTestId('count-available')).toHaveText('1');
  await expect(card(pageA, bid)).toHaveAttribute('data-state', 'available');

  // ── A2: B claims it; A's feed updates live ────────────────────────────
  await pageB.goto(`/g/${gid}/b/${bid}`);
  await pageB.getByTestId('cta-claim').click();
  await expect(pageB.getByTestId('state-badge')).toHaveAttribute('data-state', 'claimed');
  // Real-time: A's feed card flips to claimed without a reload.
  await expect(card(pageA, bid)).toHaveAttribute('data-state', 'claimed');

  // ── A3: B submits proof (real file upload to the Storage emulator) ─────
  await pageB.getByTestId('cta-submit').click();
  await pageB.waitForURL(/\/submit$/);
  await pageB.getByTestId('proof-input').setInputFiles('tests/e2e/test-assets/proof1.png');
  await expect(pageB.getByTestId('proof-tile')).toHaveCount(1);
  await pageB.getByTestId('proof-note').fill('Done! See photo.');
  await pageB.getByTestId('submit-proof').click();
  await pageB.waitForURL(new RegExp(`/b/${bid}$`));
  await expect(pageB.getByTestId('state-badge')).toHaveAttribute('data-state', 'pending_review');

  // Real-time: the bounty shows up in A's review queue without a reload.
  await pageA.goto('/reviews');
  await expect(pageA.locator(`[data-testid="review-row"][data-bounty-id="${bid}"]`)).toBeVisible();

  // ── A4: A approves ────────────────────────────────────────────────────
  const reviewRow = pageA.locator(`[data-testid="review-row"][data-bounty-id="${bid}"]`);
  await reviewRow.click();
  await pageA.getByTestId('approve').click();
  // Wait for the approval to land (row leaves the queue) before navigating,
  // otherwise the goto would cancel the in-flight callable.
  await expect(reviewRow).toHaveCount(0);
  // Bounty resolved successful (check on the detail page).
  await pageA.goto(`/g/${gid}/b/${bid}`);
  await expect(pageA.getByTestId('state-badge')).toHaveAttribute('data-state', 'successful');

  // Leaderboard reflects B's +25 / 1 win (B is now rank 1 on the podium).
  await pageA.goto(`/g/${gid}/leaderboard`);
  const gold = pageA.locator(`[data-testid="podium-1"][data-uid="${seed.users.B.uid}"]`);
  await expect(gold).toBeVisible();
  await expect(gold).toContainText('25');

  // ── A5: settle the IOU (two-party), observed live on A's profile ───────
  await pageA.goto('/u/me');
  const openRow = pageA.getByTestId('iou-open-row');
  await expect(openRow).toHaveCount(1);
  await openRow.getByTestId('iou-action').click();           // A (debtor) marks paid
  await expect(pageA.getByTestId('iou-waiting')).toBeVisible();

  await pageB.goto('/u/me');
  await pageB.getByTestId('iou-open-row').getByTestId('iou-action').click(); // B confirms

  // Real-time on A: the open IOU clears and a settled one appears.
  await expect(pageA.getByTestId('iou-open-row')).toHaveCount(0);
  await expect(pageA.getByTestId('settled-ious')).toBeVisible();

  await ctxA.close();
  await ctxB.close();
});
