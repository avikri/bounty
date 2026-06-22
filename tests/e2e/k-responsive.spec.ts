/**
 * [K] Responsive layout at the three documented breakpoints. These assert the
 * STRUCTURAL presence/absence of the navigation chrome (tab bar, sidebar, right
 * rail, FAB, floating bell). Pure visual polish (spacing, exact widths) remains
 * a manual check — see tests/e2e/README.md.
 */
import { test, expect, PERSONAS } from './fixtures/test';
import { signInAndVisit } from './helpers/auth';
import { loginSeedUser } from './fixtures/seed';
import { toPendingReview } from './helpers/flows';

test.describe('[K1][P2] mobile (<960px)', () => {
  test.use({ viewport: { width: 500, height: 900 } });

  test('shows the bottom tab bar + FAB + floating bell, hides sidebar/rail', async ({ page, seed }) => {
    await signInAndVisit(page, PERSONAS.A, `/g/${seed.groupId}`);
    await expect(page.getByTestId('tabbar')).toBeVisible();
    await expect(page.getByTestId('tab-post')).toBeVisible();
    await expect(page.getByTestId('bell')).toBeVisible();
    await expect(page.getByTestId('fab-post')).toBeVisible();
    await expect(page.getByTestId('sidebar')).toBeHidden();
    await expect(page.getByTestId('rail')).toBeHidden();
  });
});

test.describe('[K1b][P1] settings is reachable + usable on mobile (<960px)', () => {
  // iPhone 12/13-sized viewport.
  test.use({ viewport: { width: 390, height: 844 } });

  test('open the mobile group header → settings; content + a control are usable', async ({ page, seed }) => {
    await signInAndVisit(page, PERSONAS.A, `/g/${seed.groupId}`);

    // The desktop header entry point is hidden on mobile; the gear in the
    // mobile header is the only way in.
    await expect(page.getByTestId('group-settings-link')).toBeHidden();
    const gear = page.getByTestId('group-settings-link-mobile');
    await expect(gear).toBeVisible();
    await gear.click();

    await expect(page).toHaveURL(new RegExp(`/g/${seed.groupId}/settings$`));

    // Settings content rendered and an interactive control reachable/usable.
    await expect(page.getByTestId('invite-code')).toBeVisible();
    const name = page.locator('input.input').first();
    await expect(name).toBeVisible();
    await name.fill('Renamed on mobile');
    await expect(name).toHaveValue('Renamed on mobile');

    // No horizontal overflow at this width.
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
  });
});

test.describe('[K2][P2] desktop (≥1200px)', () => {
  test.use({ viewport: { width: 1300, height: 900 } });

  test('shows the sidebar + right rail, hides the tab bar and bell', async ({ page, seed }) => {
    await signInAndVisit(page, PERSONAS.A, `/g/${seed.groupId}`);
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('rail')).toBeVisible();
    await expect(page.getByTestId('tabbar')).toBeHidden();
    await expect(page.getByTestId('bell')).toBeHidden();
    await expect(page.getByTestId('fab-post')).toBeHidden();
  });

  test('the desktop header Settings link still reaches settings; mobile gear is hidden', async ({ page, seed }) => {
    await signInAndVisit(page, PERSONAS.A, `/g/${seed.groupId}`);
    await expect(page.getByTestId('group-settings-link-mobile')).toBeHidden();
    const link = page.getByTestId('group-settings-link');
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/g/${seed.groupId}/settings$`));
    await expect(page.getByTestId('invite-code')).toBeVisible();
  });
});

test.describe('[K3][P2] tablet (960–1199px)', () => {
  test.use({ viewport: { width: 1000, height: 800 } });

  test('shows the sidebar but no right rail or tab bar', async ({ page, seed }) => {
    await signInAndVisit(page, PERSONAS.A, `/g/${seed.groupId}`);
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('rail')).toBeHidden();
    await expect(page.getByTestId('tabbar')).toBeHidden();
  });

  test('review queue is a split panel; selecting a row updates the ?id query', async ({ page, seed }) => {
    const gid = seed.groupId;
    const a = await loginSeedUser(PERSONAS.A);
    const b = await loginSeedUser(PERSONAS.B);
    const bid = await toPendingReview(a, b, gid, { title: 'Reviewable' });
    await a.dispose(); await b.dispose();

    await signInAndVisit(page, PERSONAS.A, '/reviews');
    await page.locator(`[data-testid="review-row"][data-bounty-id="${bid}"]`).click();
    await expect(page).toHaveURL(new RegExp(`[?&]id=${bid}`));
    await expect(page.getByTestId('review-detail')).toBeVisible();
  });
});
