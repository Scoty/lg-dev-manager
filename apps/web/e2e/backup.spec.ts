import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { addRootedTv, expect, test } from './fixtures';

interface BackupFile {
  format: string;
  version: number;
  exportedAt: number;
  devices: { id: string; name: string; username: string; host: string }[];
}

/** Pick a file for the (hidden) "Import backup" input the way a user does. */
async function importFile(page: Page, path: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import backup' }).click();
  await (await chooser).setFiles(path);
}

test('backup: export, remove all, import restores the TV, a hostile backup is refused', async ({ paired: page, errors }) => {
  await addRootedTv(page, 'Backup Den');
  const tvRow = page.locator('.data-cell-user-name').getByText('Backup Den', { exact: true });

  // Export: confirms first (the file holds keys and passwords), then downloads a JSON file.
  await page.getByRole('button', { name: 'Export backup' }).click();
  const confirm = page.getByRole('dialog', { name: 'Download a backup?' });
  await expect(confirm).toBeVisible();
  const download = page.waitForEvent('download');
  await confirm.getByRole('button', { name: 'Download' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^lg-dev-manager-devices-\d{4}-\d{2}-\d{2}\.json$/);
  const backupPath = await file.path();
  const backup = JSON.parse(readFileSync(backupPath, 'utf8')) as BackupFile;
  expect(backup.format).toBe('lg-dev-manager/devices');
  expect(backup.devices.map((d) => d.name)).toEqual(['Backup Den']);

  // Remove all (after its confirmation): the list is empty.
  await page.getByRole('button', { name: 'Remove all from this browser' }).click();
  await page.getByRole('dialog', { name: 'Remove all TVs from this browser?' }).getByRole('button', { name: 'Remove all' }).click();
  await expect(page.getByText('All device settings were removed from this browser.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No TVs yet' })).toBeVisible();
  await expect(tvRow).toHaveCount(0);

  // Importing the exported file brings the TV back.
  await importFile(page, backupPath);
  await expect(page.getByText('Imported 1 device.')).toBeVisible();
  await expect(tvRow).toBeVisible();

  // A hand-made backup with a user name that ssh would read as an option is refused, and nothing is added.
  const dir = mkdtempSync(join(tmpdir(), 'lgdm-backup-'));
  const hostilePath = join(dir, 'hostile.json');
  const hostile: BackupFile = {
    ...backup,
    devices: [{ ...backup.devices[0]!, id: randomUUID(), name: 'Backup Trap', username: '-oProxyCommand=sh' }],
  };
  writeFileSync(hostilePath, JSON.stringify(hostile));
  await importFile(page, hostilePath);
  await expect(page.getByText(/Nothing was imported: TV “Backup Trap” in this backup has a user name that isn’t allowed/)).toBeVisible();
  await expect(page.locator('.data-cell-user-name').getByText('Backup Trap', { exact: true })).toHaveCount(0);
  await expect(tvRow).toBeVisible();

  expect(errors).toEqual([]);
});
