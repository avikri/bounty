/**
 * [E] Real-time propagation — the highest-value manual-only area. An observer
 * sits in a browser context while a separate live SDK actor mutates server
 * state; the browser must reflect the change via onSnapshot with no reload.
 *
 * (Two-context *UI* propagation — both sides in browsers — is additionally
 * proven by a-happy-path.spec; here we use an SDK actor so the trigger is
 * deterministic and the assertion focuses purely on observer-side propagation,
 * using web-first polling rather than fixed waits.)
 */
import { test, expect, PERSONAS } from './fixtures/test';
import { signInAndVisit } from './helpers/auth';
import { loginSeedUser, postBounty } from './fixtures/seed';
import { postAndClaim, approve, toPendingReview } from './helpers/flows';

test('[E1][P1] feed shows a newly-posted bounty without refresh', async ({ page, seed }) => {
  const gid = seed.groupId;
  await signInAndVisit(page, PERSONAS.A, `/g/${gid}`);
  await expect(page.getByTestId('count-available')).toHaveText('0');

  const b = await loginSeedUser(PERSONAS.B);
  const bid = await postBounty(b, gid, { title: 'Live-posted chore' });
  await b.dispose();

  await expect(page.getByTestId('count-available')).toHaveText('1');
  await expect(page.locator(`[data-testid="bounty-card"][data-bounty-id="${bid}"]`)).toBeVisible();
});

test('[E2][P1] review queue shows a submission without refresh', async ({ page, seed }) => {
  const gid = seed.groupId;
  const a = await loginSeedUser(PERSONAS.A);
  const b = await loginSeedUser(PERSONAS.B);
  const bid = await postAndClaim(a, b, gid, { title: 'Awaiting submit' });

  await signInAndVisit(page, PERSONAS.A, '/reviews');
  const row = page.locator(`[data-testid="review-row"][data-bounty-id="${bid}"]`);
  await expect(row).toHaveCount(0); // not submitted yet

  await b.call('submitProof', { groupId: gid, bountyId: bid, proof: { urls: [], note: 'done' } });
  await expect(row).toBeVisible(); // appears live
  await a.dispose(); await b.dispose();
});

test('[E3][P1] inbox shows a new notification without refresh', async ({ page, seed }) => {
  const gid = seed.groupId;
  const a = await loginSeedUser(PERSONAS.A);
  const bid = await postBounty(a, gid, { title: 'Notify me' });

  await signInAndVisit(page, PERSONAS.A, '/inbox');
  await expect(page.getByTestId('unread-count')).toHaveText('0');

  const b = await loginSeedUser(PERSONAS.B);
  await b.call('claimBounty', { groupId: gid, bountyId: bid });
  await b.dispose(); await a.dispose();

  await expect(page.locator('[data-testid="notif"][data-kind="bounty_claimed"]')).toBeVisible();
  await expect(page.getByTestId('unread-count')).not.toHaveText('0');
});

test('[E4][P1] leaderboard updates points after an approval without refresh', async ({ page, seed }) => {
  const gid = seed.groupId;
  const a = await loginSeedUser(PERSONAS.A);
  const b = await loginSeedUser(PERSONAS.B);
  const bid = await toPendingReview(a, b, gid, { title: 'Worth 25', price: 25 });

  await signInAndVisit(page, PERSONAS.B, `/g/${gid}/leaderboard`);
  // B has no points yet.
  const goldIsB = page.locator(`[data-testid="podium-1"][data-uid="${seed.users.B.uid}"]`);

  await approve(a, gid, bid);
  await a.dispose(); await b.dispose();

  // B rises to the top of the podium with 25 points, live.
  await expect(goldIsB).toBeVisible();
  await expect(goldIsB).toContainText('25');
});
