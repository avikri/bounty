/**
 * [I] Notifications inbox UI: presence + colour of each kind, day-grouping,
 * mark-one-read, mark-all-read and the unread counter. Notification CREATION is
 * covered by functions.spec; here we assert the inbox interactions.
 */
import { test, expect, PERSONAS } from './fixtures/test';
import { signInAndVisit } from './helpers/auth';
import { loginSeedUser } from './fixtures/seed';
import { approve, toPendingReview } from './helpers/flows';
import { seedNotification } from './fixtures/admin';

/** Run a full cycle so A accrues three unread notifications. */
async function accrueNotifsForA(gid: string): Promise<void> {
  const a = await loginSeedUser(PERSONAS.A);
  const b = await loginSeedUser(PERSONAS.B);
  const bid = await toPendingReview(a, b, gid);
  await approve(a, gid, bid);
  await a.dispose(); await b.dispose();
}

test('[I1][P1] every triggered notification kind appears with its colour dot', async ({ page, seed }) => {
  await accrueNotifsForA(seed.groupId);
  await signInAndVisit(page, PERSONAS.A, '/inbox');

  for (const kind of ['bounty_claimed', 'proof_submitted', 'bounty_resolved']) {
    await expect(page.locator(`[data-testid="notif"][data-kind="${kind}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="dot-${kind}"]`).first()).toBeVisible();
  }
});

test('[I3][P1] marking one notification read decrements the unread count', async ({ page, seed }) => {
  await accrueNotifsForA(seed.groupId);
  await signInAndVisit(page, PERSONAS.A, '/inbox');
  await expect(page.getByTestId('unread-count')).toHaveText('3');

  // Opening a notification marks it read, then client-navigates to the bounty.
  // Return to the inbox client-side (goBack) rather than a full reload: the
  // fire-and-forget read write and the live onSnapshot run in the same JS
  // context, so the unread count settles to 2 without a race.
  await page.getByTestId('notif').first().click();
  await page.waitForURL(/\/g\/[^/]+\/b\/[^/]+/);
  await page.goBack();
  await page.waitForURL(/\/inbox$/);
  await expect(page.getByTestId('unread-count')).toHaveText('2');
});

test('[I4][P1] mark-all-read clears the unread count', async ({ page, seed }) => {
  await accrueNotifsForA(seed.groupId);
  await signInAndVisit(page, PERSONAS.A, '/inbox');
  await expect(page.getByTestId('unread-count')).toHaveText('3');

  await page.getByTestId('mark-all').click();
  await expect(page.getByTestId('unread-count')).toHaveText('0');
  await expect(page.getByTestId('mark-all')).toHaveCount(0);
});

test('[I2][P2] inbox groups notifications by day (Today / Yesterday)', async ({ page, seed }) => {
  const uid = seed.users.A.uid;
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await seedNotification(uid, { kind: 'bounty_resolved', title: 'Older' }, yesterday);
  await seedNotification(uid, { kind: 'bounty_claimed', title: 'Fresh' }, new Date());

  await signInAndVisit(page, PERSONAS.A, '/inbox');
  const labels = page.getByTestId('day-label');
  await expect(labels.filter({ hasText: 'Today' })).toBeVisible();
  await expect(labels.filter({ hasText: 'Yesterday' })).toBeVisible();
});
