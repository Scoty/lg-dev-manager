import { addDevModeTv, addRootedTv, expect, test } from './fixtures';

/** Litefin repo (M8) against the rig's fake GitHub releases. */

test('lists the last 5 releases by build, and installs one straight onto the TV', async ({ paired: page, errors }) => {
  await addDevModeTv(page, 'Litefin Dev');
  await page.goto('/#/apps/litefin');
  const table = page.locator('.litefin-table');
  await expect(table.locator('tbody tr')).toHaveCount(5, { timeout: 30_000 });
  // Newest first; the pre-release, the draft and the 6th release are left out.
  await expect(table.locator('.litefin-version')).toHaveText(['v1.9.0', 'v1.8.0', 'v1.7.0', 'v1.6.0', 'v1.5.1']);
  await expect(table.locator('thead th')).toHaveText([/Release/, /Modern/, /^Normal/, /^Legacy/, /^Ultra Legacy\s*webOS/, /no service/]);
  // The mock TV runs webOS 8: Modern is suggested.
  // (the TV's webOS version comes from a background read, so allow it time)
  await expect(table.locator('thead th.is-suggested')).toContainText('Modern', { timeout: 30_000 });
  // v1.7.0 has no Modern build.
  await expect(table.locator('tbody tr').nth(2).locator('td').first()).toContainText('No Modern build');
  await expect(page.getByText(/Litefin (isn’t installed|v[\d.]+ is installed) on Litefin Dev/)).toBeVisible();

  await page.getByRole('button', { name: 'Install Litefin 1.7.0 Legacy' }).click();
  // The rig's TV is shared and kept between retries: Litefin may already be there.
  await expect(page.getByRole('dialog')).toBeVisible();
  const replace = page.getByRole('dialog', { name: /Replace Litefin/ });
  if (await replace.count()) await replace.getByRole('button', { name: 'Install' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/Litefin.* v1\.7\.0 is installed/)).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Litefin v1.7.0 is installed on Litefin Dev')).toBeVisible();
  await expect(page.getByText('v1.9.0 available')).toBeVisible();
  await expect(table.locator('tbody tr').nth(2)).toContainText('Installed');

  // Installing another build asks first (it replaces the installed one).
  await page.getByRole('button', { name: 'Install Litefin 1.9.0 Normal' }).click();
  const ask = page.getByRole('dialog', { name: /Replace Litefin/ });
  await expect(ask).toContainText('replaces it');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  expect(errors).toEqual([]);
});

test('a build that fails GitHub’s checksum is not installed', async ({ paired: page }) => {
  await addRootedTv(page, 'Litefin Root');
  await page.goto('/#/apps/litefin');
  // Wait for the TV's apps, so whether the "Replace" question comes is settled.
  await expect(page.getByText(/Litefin (isn’t installed|v[\d.]+ is installed) on Litefin Root/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Install Litefin 1.8.0 Legacy' }).click({ timeout: 30_000 });
  await expect(page.getByRole('dialog')).toBeVisible();
  const confirmReplace = page.getByRole('dialog', { name: /Replace Litefin/ });
  if (await confirmReplace.count()) await confirmReplace.getByRole('button', { name: 'Install' }).click();
  await expect(page.getByRole('dialog').getByText('Install failed')).toBeVisible({ timeout: 30_000 });
});
