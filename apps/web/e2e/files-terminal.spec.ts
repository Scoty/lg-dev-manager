import { readFileSync } from 'node:fs';
import { addDevModeTv, addRootedTv, expect, NO_PTY_PORT, test } from './fixtures';

/**
 * Files and Terminal against the mock TVs. The rig's TVs are shared with other specs, so the files test works
 * inside its own folder (e2e-files) and deletes it at the end.
 */

test('files: browse, new folder, upload, replace, preview, download, rename, delete', async ({ paired: page, errors }) => {
  await addDevModeTv(page, 'Files Dev');
  await page.goto('/#/files');
  await expect(page.locator('.hero-sub')).toContainText('Browse Files Dev (LG C3) over SFTP.', { timeout: 30_000 });
  const table = page.locator('.files-table');
  await expect(table.getByRole('button', { name: 'notes.txt' })).toBeVisible({ timeout: 30_000 });
  await expect(table.getByText('→ /media/developer/apps')).toBeVisible();
  await expect(page.getByText(/free of/)).toBeVisible();

  // A folder of our own.
  await page.getByRole('button', { name: 'New folder' }).click();
  const nameDialog = page.getByRole('dialog', { name: 'New folder' });
  await nameDialog.getByRole('textbox').fill('e2e-files');
  await nameDialog.getByRole('button', { name: 'Create' }).click();
  await table.getByRole('button', { name: 'e2e-files' }).click();
  await expect(page.getByText('This folder is empty')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Folder path' })).toContainText('e2e-files');

  // Upload, then upload again and replace.
  await page.locator('.files-card input[type=file]').setInputFiles({ name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('first version\n') });
  await expect(table.getByRole('button', { name: 'hello.txt' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Uploaded hello.txt')).toBeVisible();
  await page.locator('.files-card input[type=file]').setInputFiles({ name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('second version\n') });
  await page.getByRole('dialog', { name: 'Replace hello.txt?' }).getByRole('button', { name: 'Replace' }).click();
  await expect(page.getByText('Uploaded hello.txt').last()).toBeVisible({ timeout: 30_000 });

  // Preview shows the text as text.
  await table.getByRole('button', { name: 'hello.txt' }).click();
  const preview = page.getByRole('dialog', { name: 'hello.txt' });
  await expect(preview.locator('pre')).toHaveText('second version\n');

  // Download from the preview.
  const dl = page.waitForEvent('download');
  await preview.getByRole('button', { name: 'Download' }).click();
  const file = await dl;
  expect(file.suggestedFilename()).toBe('hello.txt');
  expect(readFileSync(await file.path()).toString()).toBe('second version\n');

  // Rename.
  await page.getByLabel('Select hello.txt').check({ force: true });
  await page.getByRole('toolbar', { name: 'Selected items' }).getByRole('button', { name: 'Rename' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename hello.txt' });
  await rename.getByRole('textbox').fill('renamed.txt');
  await rename.getByRole('button', { name: 'Rename' }).click();
  await expect(table.getByRole('button', { name: 'renamed.txt' })).toBeVisible();
  await expect(table.getByRole('button', { name: 'hello.txt' })).toHaveCount(0);

  // Up, then delete the whole folder (asks first).
  await page.getByRole('button', { name: 'Up one folder' }).click();
  await page.getByLabel('Select e2e-files').check({ force: true });
  await page.getByRole('toolbar', { name: 'Selected items' }).getByRole('button', { name: 'Delete' }).click();
  const ask = page.getByRole('dialog', { name: 'Delete e2e-files?' });
  await expect(ask.getByText(/and everything in it/)).toBeVisible();
  await ask.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Deleted e2e-files')).toBeVisible({ timeout: 30_000 });
  await expect(table.getByRole('button', { name: 'e2e-files' })).toHaveCount(0);

  // Type a path; a missing one explains itself.
  await page.getByRole('button', { name: 'Type a path' }).click();
  await page.getByLabel('Path').fill('/etc');
  await page.getByLabel('Path').press('Enter');
  await expect(table.getByRole('button', { name: 'prefs' })).toBeVisible();
  await expect(table.locator('tr', { hasText: 'prefs' }).locator('.files-lock')).toBeVisible();
  // Not allowed: the error offers Retry, and Close leaves it alone.
  await page.getByLabel('Select prefs').check({ force: true });
  await page.getByRole('toolbar', { name: 'Selected items' }).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete prefs?' }).getByRole('button', { name: 'Delete' }).click();
  const failed = page.getByRole('dialog', { name: 'Deleting' });
  await expect(failed.getByText('You don’t have permission to delete /etc/prefs.')).toBeVisible({ timeout: 30_000 });
  await expect(failed.getByRole('button', { name: 'Retry' })).toBeVisible();
  await failed.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(table.getByRole('button', { name: 'prefs' })).toBeVisible();
  await page.getByRole('button', { name: 'Type a path' }).click();
  await page.getByLabel('Path').fill('/nope');
  await page.getByLabel('Path').press('Enter');
  await expect(page.getByText('/nope doesn’t exist.')).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(table.getByRole('button', { name: 'prefs' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('terminal: run commands, keep the tab across pages, exit and reconnect', async ({ paired: page, errors }) => {
  await addRootedTv(page, 'Term Root');
  await page.goto('/#/terminal');
  await page.getByRole('button', { name: 'Open a terminal on Term Root' }).click();
  const screen = page.locator('.term-stage .xterm-rows');
  await expect(screen).toContainText('root@LGwebOSTV:/home/root#', { timeout: 30_000 });
  await page.locator('.term-stage .xterm').click();
  await page.keyboard.type('echo hello-from-e2e\r');
  await expect(screen).toContainText('hello-from-e2e', { timeout: 10_000 });

  // The console notes the shell, not what was typed.
  await expect(page.locator('.console-dock')).toContainText('1 running');

  // Still there after visiting another page.
  await page.goto('/#/devices');
  await page.goto('/#/terminal');
  await expect(page.locator('.term-stage .xterm-rows')).toContainText('hello-from-e2e');

  // A second tab, then close it.
  await page.getByRole('button', { name: 'New terminal' }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('button', { name: /^Close / }).last().click();
  await expect(page.getByRole('tab')).toHaveCount(1);

  // Exit, then reconnect in the same tab.
  await page.locator('.term-stage .xterm').click();
  await page.keyboard.type('exit\r');
  await expect(page.getByText('The shell has ended')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Reconnect' }).click();
  await expect(page.getByText('The shell has ended')).toHaveCount(0);
  await expect(screen).toContainText('[Reconnecting…]');
  await expect(page.locator('.term-dot.is-open')).toBeVisible({ timeout: 10_000 });
  await page.locator('.term-stage .xterm').click();
  await page.keyboard.type('echo again-ok\r');
  await expect(screen).toContainText('again-ok', { timeout: 10_000 });
  expect(errors).toEqual([]);
});

test('terminal: a TV that refuses a PTY gets the simple shell', async ({ paired: page, errors }) => {
  await addRootedTv(page, 'No PTY', NO_PTY_PORT);
  await page.goto('/#/terminal');
  await page.getByRole('button', { name: 'Open a terminal on No PTY' }).click();
  await expect(page.getByText('This shell has no terminal (PTY)')).toBeVisible({ timeout: 30_000 });
  const form = page.locator('.term-dumb-form');
  await form.getByLabel('Command').fill('whoami');
  await form.getByRole('button', { name: 'Run' }).click();
  const entry = page.locator('.term-dumb-entry').last();
  await expect(entry).toContainText('root');
  await expect(entry).toContainText('exit 0');
  await form.getByLabel('Command').fill('nope');
  await form.getByLabel('Command').press('Enter');
  await expect(page.locator('.term-dumb-entry').last()).toContainText('exit 127');
  expect(errors).toEqual([]);
});
