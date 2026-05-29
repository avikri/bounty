/**
 * [F] UI side of auto-expiry: the Expired badge renders and an expired bounty
 * drops out of the active (Available) feed count. The expiry LOGIC is covered
 * deterministically by tests/integration/expiry.spec (runBountyExpiry); here we
 * force the terminal state via admin and assert the UI reacts.
 */
import { test, expect, PERSONAS } from './fixtures/test';
import { signInAndVisit } from './helpers/auth';
import { loginSeedUser, postBounty } from './fixtures/seed';
import { forceExpire } from './fixtures/admin';

test('[F3][P1] an expired bounty shows the Expired badge and leaves the Available count', async ({ page, seed }) => {
  const gid = seed.groupId;
  const a = await loginSeedUser(PERSONAS.A);
  const bid = await postBounty(a, gid, { title: 'Will expire' });
  await a.dispose();

  await signInAndVisit(page, PERSONAS.A, `/g/${gid}`);
  await expect(page.getByTestId('count-available')).toHaveText('1');
  const cardLoc = page.locator(`[data-testid="bounty-card"][data-bounty-id="${bid}"]`);
  await expect(cardLoc).toHaveAttribute('data-state', 'available');

  await forceExpire(gid, bid);

  // Live: card flips to expired, and the Available filter no longer counts it.
  await expect(cardLoc).toHaveAttribute('data-state', 'expired');
  await expect(page.getByTestId('count-available')).toHaveText('0');

  // Detail shows the Expired state badge.
  await page.goto(`/g/${gid}/b/${bid}`);
  await expect(page.getByTestId('state-badge')).toHaveAttribute('data-state', 'expired');
});
