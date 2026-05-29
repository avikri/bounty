/**
 * [D] Role/permission UI: the controls a member must NOT see, and the owner's
 * role-change control. The underlying rule/callable enforcement (D1–D4, D7–D10)
 * is covered by rules.spec/functions.spec; this is the UI surface (D5, D6).
 */
import { test, expect, PERSONAS } from './fixtures/test';
import { signInAndVisit } from './helpers/auth';

test('[D5][P1] a plain member sees no Regenerate-invite-code control', async ({ page, seed }) => {
  await signInAndVisit(page, PERSONAS.B, `/g/${seed.groupId}/settings`);
  await expect(page.getByTestId('invite-code')).toBeVisible();   // can view
  await expect(page.getByTestId('regen-code')).toHaveCount(0);   // but not regenerate
});

test('[D6][P1] the owner can promote a member to admin from settings', async ({ page, seed }) => {
  await signInAndVisit(page, PERSONAS.A, `/g/${seed.groupId}/settings`);
  const bRow = page.locator(`[data-testid="member-row"][data-uid="${seed.users.B.uid}"]`);
  await expect(bRow.getByTestId('member-role')).toHaveText('member');

  await bRow.getByTestId('promote').click();
  await expect(bRow.getByTestId('member-role')).toHaveText('admin');
});
