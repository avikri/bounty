/**
 * [H] Leaderboard rendering: podium of the top 3 and rank ordering by points
 * descending (with a 4th member appearing in the table). The points math itself
 * is covered by functions.spec ([H1]); this is the view layer.
 */
import { test, expect, PERSONAS } from './fixtures/test';
import { signInAndVisit } from './helpers/auth';
import { loginSeedUser } from './fixtures/seed';
import { approve, toPendingReview } from './helpers/flows';

test('[H2][H3][P1] podium shows the top 3 and ranks by points descending', async ({ page, seed }) => {
  const gid = seed.groupId;
  const a = await loginSeedUser(PERSONAS.A);
  const b = await loginSeedUser(PERSONAS.B);
  const c = await loginSeedUser(PERSONAS.C);
  const d = await loginSeedUser(PERSONAS.D);
  await d.call('joinGroup', { inviteCode: seed.inviteCode }); // D becomes a 4th member

  // Distinct totals so ranking is unambiguous: B=30, C=20, D=10, A=0.
  for (const [claimant, price] of [[b, 30], [c, 20], [d, 10]] as const) {
    const bid = await toPendingReview(a, claimant, gid, { price });
    await approve(a, gid, bid);
  }
  await Promise.all([a, b, c, d].map((u) => u.dispose()));

  await signInAndVisit(page, PERSONAS.A, `/g/${gid}/leaderboard`);

  // Podium order: gold=B(30), silver=C(20), bronze=D(10).
  await expect(page.locator(`[data-testid="podium-1"][data-uid="${seed.users.B.uid}"]`)).toContainText('30');
  await expect(page.locator(`[data-testid="podium-2"][data-uid="${seed.users.C.uid}"]`)).toContainText('20');
  await expect(page.locator(`[data-testid="podium-3"][data-uid="${seed.users.D.uid}"]`)).toContainText('10');

  // A (0 points) falls to the table below the podium at rank 4.
  const aRow = page.locator(`[data-testid="lb-row"][data-uid="${seed.users.A.uid}"]`);
  await expect(aRow).toBeVisible();
  await expect(aRow).toContainText('4');
});
