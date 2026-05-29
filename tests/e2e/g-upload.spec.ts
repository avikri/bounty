/**
 * [G] Proof upload edge cases through the real submit UI: the 3-file limit,
 * oversize/type rejection (client-side), video acceptance, the lightbox, and a
 * note-only submission. Storage-rule content-type/claimant gating is asserted
 * in tests/integration/storage.rules.spec.
 */
import { test, expect, PERSONAS } from './fixtures/test';
import { signInAndVisit } from './helpers/auth';
import { loginSeedUser } from './fixtures/seed';
import { postAndClaim } from './helpers/flows';
import { Page } from '@playwright/test';

const IMG = 'tests/e2e/test-assets/proof1.png';
const IMG2 = 'tests/e2e/test-assets/proof2.png';
const IMG3 = 'tests/e2e/test-assets/proof3.png';
const MP4 = 'tests/e2e/test-assets/sample.mp4';
const PDF = 'tests/e2e/test-assets/sample.pdf';

/** Seed a claimed bounty for B and open B's submit page. */
async function openSubmit(page: Page, gid: string): Promise<string> {
  const a = await loginSeedUser(PERSONAS.A);
  const b = await loginSeedUser(PERSONAS.B);
  const bid = await postAndClaim(a, b, gid, { title: 'Upload target' });
  await a.dispose(); await b.dispose();
  await signInAndVisit(page, PERSONAS.B, `/g/${gid}/b/${bid}/submit`);
  return bid;
}

test('[G1][P1] uploads three valid images and submits for review', async ({ page, seed }) => {
  const bid = await openSubmit(page, seed.groupId);
  await page.getByTestId('proof-input').setInputFiles([IMG, IMG2, IMG3]);
  await expect(page.getByTestId('proof-tile')).toHaveCount(3);
  await page.getByTestId('submit-proof').click();
  await page.waitForURL(new RegExp(`/b/${bid}$`));
  await expect(page.getByTestId('state-badge')).toHaveAttribute('data-state', 'pending_review');
});

test('[G2][P1] rejects a fourth file (3-file cap)', async ({ page, seed }) => {
  await openSubmit(page, seed.groupId);
  await page.getByTestId('proof-input').setInputFiles([IMG, IMG2, IMG3, IMG]);
  // onPick stops at the cap and toasts; only three tiles are added.
  await expect(page.getByTestId('proof-tile')).toHaveCount(3);
  await expect(page.getByText(/at most 3 files/i)).toBeVisible();
});

test('[G3][P1] rejects an image over 10 MB (client cap; rule allows up to 100 MB)', async ({ page, seed }) => {
  await openSubmit(page, seed.groupId);
  await page.getByTestId('proof-input').setInputFiles({
    name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(11 * 1024 * 1024, 1),
  });
  await expect(page.getByTestId('proof-tile')).toHaveCount(0);
  await expect(page.getByText(/too large/i)).toBeVisible();
});

test('[G4][P1] accepts a video file', async ({ page, seed }) => {
  await openSubmit(page, seed.groupId);
  await page.getByTestId('proof-input').setInputFiles(MP4);
  await expect(page.getByTestId('proof-tile')).toHaveCount(1);
  // The tile renders the video variant (a <video> element).
  await expect(page.getByTestId('proof-tile').locator('video')).toBeVisible();
});

test('[G5][P1] rejects a non-image/video type (pdf)', async ({ page, seed }) => {
  await openSubmit(page, seed.groupId);
  await page.getByTestId('proof-input').setInputFiles(PDF);
  await expect(page.getByTestId('proof-tile')).toHaveCount(0);
  await expect(page.getByText(/only images or video/i)).toBeVisible();
});

test('[G6][P1] proof gallery opens a lightbox', async ({ page, seed }) => {
  const bid = await openSubmit(page, seed.groupId);
  await page.getByTestId('proof-input').setInputFiles(IMG);
  await page.getByTestId('submit-proof').click();
  await page.waitForURL(new RegExp(`/b/${bid}$`));

  // On the detail page the proof thumbnail opens a full-screen lightbox.
  await page.getByTestId('proof-thumb').first().click();
  await expect(page.getByTestId('lightbox')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('lightbox')).toHaveCount(0);
});

test('[G7][P2] submits a note with no files; review shows the no-media placeholder', async ({ page, seed }) => {
  const gid = seed.groupId;
  const bid = await openSubmit(page, gid);
  await page.getByTestId('proof-note').fill('No photo, just my word.');
  await page.getByTestId('submit-proof').click();
  await page.waitForURL(new RegExp(`/b/${bid}$`));
  await expect(page.getByTestId('state-badge')).toHaveAttribute('data-state', 'pending_review');

  // The poster's review detail shows the "no media submitted" placeholder.
  await signInAndVisit(page, PERSONAS.A, '/reviews');
  await page.locator(`[data-testid="review-row"][data-bounty-id="${bid}"]`).click();
  await expect(page.getByTestId('review-detail')).toContainText(/no media submitted/i);
});
