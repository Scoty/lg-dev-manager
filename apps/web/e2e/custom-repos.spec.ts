import { addRootedTv, expect, test } from './fixtures';

/**
 * Custom repositories against the rig's second fake repository (127.0.0.1:5296, tools/mock-tv MOCK_CUSTOM_REPO_APPS).
 * Its apps are used by no other spec.
 */
const CUSTOM = 'http://127.0.0.1:5296';
const card = (page: import('@playwright/test').Page, title: string) =>
  page.locator('.repo-card', { has: page.getByRole('button', { name: `Details for ${title}`, exact: true }) });

test('add a custom repository after checking it, browse and install from it, remove it', async ({ paired: page, errors }) => {
  await addRootedTv(page, 'Custom Repo TV');
  await page.goto('/#/repos');
  await expect(page.getByText('Unofficial repositories can contain untested apps or malware')).toBeVisible();
  await expect(page.getByText('No custom repositories')).toBeVisible();

  // Nothing typed, risk not acknowledged: the form says what's missing and asks nothing of the bridge.
  await page.getByRole('button', { name: 'Check & add' }).click();
  await expect(page.getByText('Enter the repository’s address.')).toBeVisible();
  await expect(page.getByText('Tick this to add the repository.')).toBeVisible();

  // Not a repository: the bridge checks before anything is saved.
  await page.getByLabel('Repository address').fill(`${CUSTOM}/api/nothing.json`);
  await page.locator('label.check', { hasText: 'I understand that apps from this repository' }).click();
  await page.getByRole('button', { name: 'Check & add' }).click();
  await expect(page.getByText('There’s no webOS Homebrew repository at that address.', { exact: false })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('No custom repositories')).toBeVisible();

  // The folder form of the address works too; the saved address is the apps.json.
  await page.getByLabel('Repository address').fill(`${CUSTOM}/api`);
  await page.getByLabel(/^Name/).fill('Friends’ apps');
  await page.getByRole('button', { name: 'Check & add' }).click();
  await expect(page.getByText('Friends’ apps added')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.custom-repos-table')).toContainText(`${CUSTOM}/api/apps.json`);
  await expect(page.getByLabel(/I understand that apps from this repository/)).not.toBeChecked(); // asked again next time

  // Renamed in place (Escape cancels, Enter saves); the sidebar follows.
  await page.getByRole('button', { name: 'Rename Friends’ apps' }).click();
  await page.getByLabel('New name for Friends’ apps').fill('Not this');
  await page.keyboard.press('Escape');
  await expect(page.locator('.custom-repos-table')).toContainText('Friends’ apps');
  await page.getByRole('button', { name: 'Rename Friends’ apps' }).click();
  await page.getByLabel('New name for Friends’ apps').fill('Club apps');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Renamed to Club apps')).toBeVisible();
  await page.getByRole('button', { name: 'Rename Club apps' }).click();
  await page.getByLabel('New name for Club apps').fill('Friends’ apps');
  await page.getByRole('button', { name: 'Save the name' }).click();
  // A long address is cut to fit, in full on hover, and the buttons stay in view.
  const address = page.locator('.custom-repo-url');
  await expect(address).toHaveAttribute('title', `${CUSTOM}/api/apps.json`);
  await expect(page.getByRole('button', { name: 'Remove Friends’ apps' })).toBeInViewport();

  // It's under Apps in the sidebar, with its own page and the warning.
  await page.locator('.d-sidebar').getByRole('button', { name: 'Apps' }).click();
  await page.locator('.d-sidebar').getByRole('link', { name: 'Friends’ apps' }).click();
  await expect(page.locator('h1')).toHaveText('Friends’ apps');
  await expect(page.getByText('Unofficial repository', { exact: true })).toBeVisible();
  await expect(card(page, 'Custom Player')).toBeVisible({ timeout: 30_000 });
  await expect(card(page, 'Repo Example')).toHaveCount(0); // the official repository's apps aren't mixed in
  // An entry in the other repository style (manifestUrl, relative addresses, HTML in its short description).
  await expect(card(page, 'Stream Client')).toContainText('v1.3.0');
  await expect(card(page, 'Stream Client')).toContainText('Game streaming, 4K & HDR');

  await card(page, 'Custom Player').getByRole('button', { name: 'Install Custom Player' }).click();
  // Every install from an unofficial repository asks first, with the warning.
  const ask = page.getByRole('dialog', { name: 'Install Custom Player from Friends’ apps?' });
  await expect(ask).toContainText('Nobody has reviewed its apps');
  await ask.getByRole('button', { name: 'Install', exact: true }).click();
  const progress = page.getByRole('dialog', { name: 'Installing Custom Player' });
  await expect(progress.getByText('Custom Player v3.1.0 is installed')).toBeVisible({ timeout: 30_000 });
  await progress.getByRole('button', { name: 'Done' }).click();
  await expect(card(page, 'Custom Player').getByRole('button', { name: 'Launch Custom Player' })).toBeVisible();

  // Details come from the custom repository too.
  await card(page, 'Custom Tool').getByRole('button', { name: 'Details for Custom Tool' }).click();
  await expect(page.getByRole('dialog').getByText('org.example.custom.tool')).toBeVisible();
  await page.keyboard.press('Escape');

  // Remove it (confirmed first): gone from the sidebar; the installed app stays on the TV.
  await page.goto('/#/repos');
  await page.getByRole('button', { name: 'Remove Friends’ apps' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('No custom repositories')).toBeVisible();
  await expect(page.locator('.d-sidebar').getByRole('link', { name: 'Friends’ apps' })).toHaveCount(0);
  await page.goto('/#/apps/installed');
  await expect(page.getByText('org.example.custom.player')).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});
