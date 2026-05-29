/**
 * [B] State-integrity from the UI side: the buttons that must NOT appear when an
 * action is illegal. The server-side rejections themselves are covered by the
 * integration suite (functions.spec/rules.spec); here we assert the UI doesn't
 * even offer the action.
 */
import { test, expect, PERSONAS } from './fixtures/test';
import { signInAndVisit } from './helpers/auth';
import { loginSeedUser, postBounty } from './fixtures/seed';
import { postAndClaim, toPendingReview } from './helpers/flows';

test('[B1][P0] poster sees no Claim button on their own available bounty', async ({ page, seed }) => {
  const a = await loginSeedUser(PERSONAS.A);
  const bid = await postBounty(a, seed.groupId);
  await a.dispose();

  await signInAndVisit(page, PERSONAS.A, `/g/${seed.groupId}/b/${bid}`);
  await expect(page.getByTestId('state-badge')).toHaveAttribute('data-state', 'available');
  await expect(page.getByTestId('cta-claim')).toHaveCount(0);
  await expect(page.getByTestId('cta-view')).toBeVisible(); // "you posted this"
});

test('[B2][P0] a third member sees no Claim button on an already-claimed bounty', async ({ page, seed }) => {
  const a = await loginSeedUser(PERSONAS.A);
  const b = await loginSeedUser(PERSONAS.B);
  const bid = await postAndClaim(a, b, seed.groupId);
  await a.dispose(); await b.dispose();

  // C (also a member) views it.
  await signInAndVisit(page, PERSONAS.C, `/g/${seed.groupId}/b/${bid}`);
  await expect(page.getByTestId('state-badge')).toHaveAttribute('data-state', 'claimed');
  await expect(page.getByTestId('cta-claim')).toHaveCount(0);
});

test('[B3][P0] a member cannot submit proof before claiming (UI offers Claim, not Submit)', async ({ page, seed }) => {
  const a = await loginSeedUser(PERSONAS.A);
  const bid = await postBounty(a, seed.groupId);
  await a.dispose();

  await signInAndVisit(page, PERSONAS.B, `/g/${seed.groupId}/b/${bid}`);
  await expect(page.getByTestId('cta-claim')).toBeVisible();
  await expect(page.getByTestId('cta-submit')).toHaveCount(0);
});

test('[B4][P0] the claimant (non-poster) sees no review controls on a pending bounty', async ({ page, seed }) => {
  const a = await loginSeedUser(PERSONAS.A);
  const b = await loginSeedUser(PERSONAS.B);
  const bid = await toPendingReview(a, b, seed.groupId);
  await a.dispose(); await b.dispose();

  await signInAndVisit(page, PERSONAS.B, `/g/${seed.groupId}/b/${bid}`);
  await expect(page.getByTestId('state-badge')).toHaveAttribute('data-state', 'pending_review');
  await expect(page.getByTestId('cta-review')).toHaveCount(0);
  await expect(page.getByTestId('cta-view')).toBeVisible(); // "awaiting OP decision"
});
