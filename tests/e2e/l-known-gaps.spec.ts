/**
 * [L] Characterization tests that PIN current behavior of known-incomplete
 * areas — they document what the app does today, not an aspirational fix.
 *  - L1: the profile page renders its sections and loads without uncaught
 *    errors (it's more complete than once thought).
 *  - L2 (== H4): the leaderboard time-range tabs are a no-op — all three ranges
 *    return identical data; only the label changes. This is a DOCUMENTED GAP.
 */
import { test, expect, PERSONAS } from './fixtures/test';
import { signInAndVisit } from './helpers/auth';
import { loginSeedUser, postBounty } from './fixtures/seed';
import { approve, toPendingReview } from './helpers/flows';

test('[L1][P1] profile page renders all sections and loads without uncaught errors', async ({ page, seed }) => {
  const gid = seed.groupId;
  // Give A a resolved bounty (as claimant) + an open IOU so all sections fill.
  const b = await loginSeedUser(PERSONAS.B);
  const a = await loginSeedUser(PERSONAS.A);
  const bid = await postBounty(b, gid, { title: 'A does this', price: 12 });
  await a.call('claimBounty', { groupId: gid, bountyId: bid });
  await a.call('submitProof', { groupId: gid, bountyId: bid, proof: { urls: [], note: 'done' } });
  await approve(b, gid, bid); // B approves → A is creditor of an open IOU + has a win
  await a.dispose(); await b.dispose();

  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await signInAndVisit(page, PERSONAS.A, '/u/me');
  await expect(page.getByTestId('stat-points')).toBeVisible();
  await expect(page.getByTestId('stat-wins')).toHaveText('1');
  await expect(page.getByTestId('stat-losses')).toBeVisible();
  await expect(page.getByTestId('open-ious')).toBeVisible();
  await expect(page.getByTestId('iou-open-row')).toHaveCount(1);
  await expect(page.getByTestId('recent-card')).toHaveCount(1);

  // Viewing ANOTHER user's profile renders but exposes no IOU controls (isMe=false).
  await page.goto(`/u/${seed.users.B.uid}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByTestId('iou-action')).toHaveCount(0);

  expect(pageErrors, `uncaught errors: ${pageErrors.join('\n')}`).toEqual([]);
});

test('[L2][H4][P1] leaderboard time-range tabs are a no-op (documented gap)', async ({ page, seed }) => {
  const gid = seed.groupId;
  // Seed some points so the board is non-trivial.
  const a = await loginSeedUser(PERSONAS.A);
  const b = await loginSeedUser(PERSONAS.B);
  const bid = await toPendingReview(a, b, gid, { price: 25 });
  await approve(a, gid, bid);
  await a.dispose(); await b.dispose();

  await signInAndVisit(page, PERSONAS.B, `/g/${gid}/leaderboard`);
  await expect(page.getByTestId('podium')).toBeVisible();

  const podiumSignature = () => page.getByTestId('podium').innerText();
  const tableSignature = () =>
    page.getByTestId('lb-row').evaluateAll((rows) =>
      rows.map((r) => `${r.getAttribute('data-uid')}:${r.textContent?.replace(/\s+/g, ' ').trim()}`));

  // All-time baseline.
  await page.getByTestId('range-all').click();
  await expect(page.getByTestId('range-all')).toHaveAttribute('data-active', 'true');
  const allPodium = await podiumSignature();
  const allTable = await tableSignature();
  await expect(page.locator('.sub')).toContainText('all time');

  // Week: label changes, active toggles… but the data is byte-for-byte identical.
  await page.getByTestId('range-week').click();
  await expect(page.getByTestId('range-week')).toHaveAttribute('data-active', 'true');
  await expect(page.locator('.sub')).toContainText('this week');
  expect(await podiumSignature()).toBe(allPodium);
  expect(await tableSignature()).toEqual(allTable);

  // Month: same story.
  await page.getByTestId('range-month').click();
  await expect(page.getByTestId('range-month')).toHaveAttribute('data-active', 'true');
  await expect(page.locator('.sub')).toContainText('this month');
  expect(await podiumSignature()).toBe(allPodium);
  expect(await tableSignature()).toEqual(allTable);
});
