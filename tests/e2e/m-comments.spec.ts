/**
 * [M] Bounty comments — the component-level "renders the live list and posts a
 * comment" check. The repo has no vitest TestBed/jsdom setup (component
 * rendering is proven through Playwright, not unit tests), so this exercises the
 * real BountyDetailPage: it posts a comment through the UI and sees it render,
 * then watches a second member's comment arrive live via onSnapshot — comments
 * are a direct client write, so the SDK actor's addDoc is the genuine path.
 */
import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { test, expect, PERSONAS } from './fixtures/test';
import { signInAndVisit } from './helpers/auth';
import { SeedUser, loginSeedUser, postBounty } from './fixtures/seed';

/** Direct client comment write (the same path the app uses). */
async function addComment(u: SeedUser, gid: string, bid: string, text: string): Promise<void> {
  await addDoc(collection(u.db, 'groups', gid, 'bounties', bid, 'comments'), {
    authorUid: u.uid,
    authorDisplayName: u.persona.name,
    text,
    createdAt: serverTimestamp(),
  });
}

test('[M1][P1] renders the live comment list and posts a comment', async ({ page, seed }) => {
  const gid = seed.groupId;
  const a = await loginSeedUser(PERSONAS.A);
  const bid = await postBounty(a, gid, { title: 'Needs comments' });

  await signInAndVisit(page, PERSONAS.A, `/g/${gid}/b/${bid}`);

  const list = page.getByTestId('comment-list');
  await expect(page.getByTestId('comment-empty')).toBeVisible();

  // Post a comment through the UI — it renders without a reload.
  await page.getByTestId('comment-input').fill('First comment!');
  await page.getByTestId('comment-submit').click();
  await expect(list.getByText('First comment!')).toBeVisible();
  await expect(page.getByTestId('comment-empty')).toHaveCount(0);

  // A second member's comment shows up live via onSnapshot.
  const b = await loginSeedUser(PERSONAS.B);
  await addComment(b, gid, bid, 'Live from Blake');
  await b.dispose();
  await expect(list.getByText('Live from Blake')).toBeVisible();

  await a.dispose();
});
