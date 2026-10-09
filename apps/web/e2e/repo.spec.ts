import { addDevModeTv, addRootedTv, expect, test } from './fixtures';

/**
 * The Homebrew repository against the fake repo in the e2e rig (tools/mock-tv/src/repo.ts). The Dev Mode and
 * rooted mock TVs are shared with other specs, so these tests use apps no other spec touches.
 */
const card = (page: import('@playwright/test').Page, title: string) => page.locator('.repo-card', { has: page.getByRole('button', { name: `Details for ${title}`, exact: true }) });

test('Dev Mode: browse, details, install, update, conflicts and incompatible apps', async ({ paired: page, errors }) => {
  await addDevModeTv(page, 'Repo Dev');
  await page.goto('/#/apps/homebrew');
  await expect(page.getByRole('button', { name: 'Details for Repo Example' })).toBeVisible({ timeout: 30_000 });
  // Both pages of apps.json are listed.
  await expect(page.getByRole('button', { name: 'Details for Second Page App' })).toBeVisible();

  // Filters and search.
  await page.getByRole('button', { name: /^Updates/ }).click();
  await expect(page.locator('.repo-card')).toHaveCount(1);
  await expect(card(page, 'YouTube AdFree')).toContainText('Update');
  await page.getByRole('button', { name: /^All/ }).click();
  await page.getByLabel('Search the repository').fill('root only');
  await expect(page.locator('.repo-card')).toHaveCount(1);
  // Dev Mode isn't rooted: root-only apps are flagged.
  await expect(card(page, 'Root Only Tool')).toContainText('May not work');
  await page.getByLabel('Search the repository').fill('');

  // Details: sanitised description, screenshots; install from the dialog.
  await page.getByRole('button', { name: 'Details for Repo Example' }).click();
  const details = page.getByRole('dialog', { name: 'Repo Example' });
  await expect(details.getByText('com.example.repoapp')).toBeVisible();
  await expect(details.getByRole('heading', { name: 'About' })).toBeVisible();
  await expect(details.getByRole('link', { name: 'the project' })).toHaveAttribute('href', 'https://example.com/repoapp');
  await expect(details.getByText('bad link')).toBeVisible();
  await expect(details.locator('a', { hasText: 'bad link' })).toHaveCount(0);
  await expect(details.locator('.repo-shot img')).toHaveCount(2);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();

  await details.getByRole('button', { name: 'Install', exact: true }).click();
  const progress = page.getByRole('dialog', { name: 'Installing Repo Example' });
  await expect(progress.getByText('Repo Example v1.2.0 is installed')).toBeVisible({ timeout: 30_000 });
  await progress.getByRole('button', { name: 'Done' }).click();
  await expect(details.getByRole('button', { name: 'Launch', exact: true })).toBeVisible();
  await expect(details.getByText('Installed', { exact: true })).toBeVisible();
  await details.getByRole('button', { name: 'Close' }).click();
  await expect(card(page, 'Repo Example')).toContainText('Installed');

  // Update from the card.
  await card(page, 'YouTube AdFree').getByRole('button', { name: 'Update YouTube AdFree' }).click();
  await expect(page.getByRole('dialog', { name: 'Updating YouTube AdFree' }).getByText('YouTube AdFree v0.5.0 is installed')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(card(page, 'YouTube AdFree')).toContainText('Installed');

  // Same id as an LG Content Store app: refused with an explanation.
  await card(page, 'Store App').getByRole('button', { name: 'Install Store App' }).click();
  const failed = page.getByRole('dialog', { name: 'Installing Store App' });
  await expect(failed.getByText('Another app with the same id (com.example.storeapp) is already installed')).toBeVisible({ timeout: 30_000 });
  await expect(failed.getByText(/Uninstall that one on the TV first/)).toBeVisible();
  await failed.getByRole('button', { name: 'Close', exact: true }).last().click();

  // Marked incompatible: asks first; cancelling installs nothing.
  await expect(card(page, 'Future App')).toContainText('May not work');
  await card(page, 'Future App').getByRole('button', { name: 'Install Future App' }).click();
  const ask = page.getByRole('dialog', { name: 'Future App may not work on Repo Dev' });
  await expect(ask.getByText('This app needs a different webOS version.')).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(card(page, 'Future App')).toContainText('Install');

  expect(errors).toEqual([]);
});

test('a download that fails its checksum is not installed', async ({ paired: page }) => {
  await addDevModeTv(page, 'Repo Checksum');
  await page.goto('/#/apps/homebrew');
  await card(page, 'Broken Download').getByRole('button', { name: 'Install Broken Download' }).click();
  const dialog = page.getByRole('dialog', { name: 'Installing Broken Download' });
  await expect(dialog.getByText(/match the repository.s checksum/)).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText(/repository entry may be broken/)).toBeVisible();
});

test('rooted: update badges on the Installed page, Homebrew Channel updates itself, beta channel', async ({ paired: page, errors }) => {
  await addRootedTv(page, 'Repo Root');
  await page.getByRole('button', { name: 'Go to apps' }).click();
  // Homebrew Channel 0.7.2 is installed; the repository has 0.7.3.
  await expect(page.getByText('v0.7.3 available')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Update Homebrew Channel to 0.7.3' }).click();
  await expect(page.getByText('Installed by Homebrew Channel on Repo Root.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('v0.7.3 available')).toHaveCount(0);

  // Repo details from the row menu.
  await page.getByRole('button', { name: 'More actions for Moonlight' }).click();
  await page.getByRole('menuitem', { name: 'Homebrew repo details' }).click();
  await expect(page.getByRole('dialog', { name: 'Moonlight' }).getByText('Game streaming client')).toBeVisible();
  await page.getByRole('dialog', { name: 'Moonlight' }).getByRole('button', { name: 'Close' }).click();

  // Rooted: root-only apps aren't flagged; the beta channel installs the beta.
  await page.goto('/#/apps/homebrew');
  await expect(card(page, 'Root Only Tool')).not.toContainText('May not work', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Details for Beta Channel App' }).click();
  const details = page.getByRole('dialog', { name: 'Beta Channel App' });
  await details.getByRole('button', { name: 'Install beta 1.1.0-beta.1' }).click();
  await expect(page.getByRole('dialog', { name: 'Installing the beta of Beta Channel App' }).getByText(/v1\.1\.0-beta\.1 is installed/)).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});
