import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { addDevModeTv, addRootedTv, expect, test } from './fixtures';

/** Debug tools against the rig's mock TVs (M7). */

test('system log, log levels and kernel log', async ({ paired: page, errors }) => {
  await addRootedTv(page, 'Debug Root');
  await page.goto('/#/debug/logs');
  const log = page.getByRole('log', { name: 'System log' });
  await expect(log).toContainText('APP_LAUNCH', { timeout: 30_000 });
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  // It keeps coming.
  const count = async () => Number(((await page.locator('.log-card .data-foot').textContent()) ?? '').match(/of ([\d,]+) lines/)![1]!.replace(/,/g, ''));
  const before = await count();
  await expect.poll(count, { timeout: 10_000 }).toBeGreaterThan(before);

  // Level filter and search.
  await page.getByLabel('Lowest level to show').selectOption('err');
  await expect(log.locator('.log-row.lvl-info')).toHaveCount(0);
  await expect(log.locator('.log-row.lvl-err').first()).toBeVisible();
  await page.getByLabel('Lowest level to show').selectOption('debug');
  await page.getByLabel('Filter lines').fill('LSHUB_NO_SERVICE');
  await expect(log.locator('button.log-row').first()).toContainText('Service not found');
  await log.locator('button.log-row').first().click();
  await expect(page.locator('.log-details')).toContainText('com.example.gone');
  await page.getByLabel('Filter lines').fill('');

  // Clearing the log on the TV asks first.
  await page.getByRole('button', { name: 'Clear on TV…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByText('System log cleared')).toBeVisible();

  // Log levels.
  await page.getByRole('link', { name: 'Log levels' }).first().click();
  await expect(page.getByLabel('sam', { exact: true })).toHaveValue(/info|debug|warning/, { timeout: 30_000 });
  await page.getByLabel('sam', { exact: true }).selectOption('debug');
  await expect(page.getByLabel('sam', { exact: true })).toHaveValue('debug');
  const ctx = page.getByRole('textbox', { name: 'Context', exact: true });
  await ctx.fill('com.example.mine');
  await page.getByLabel('Level', { exact: true }).selectOption('warning');
  await page.getByRole('button', { name: 'Set level' }).click();
  await expect(page.getByLabel('com.example.mine')).toHaveValue('warning');
  await ctx.fill("x'; reboot");
  await expect(page.getByText('Letters, digits and')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set level' })).toBeDisabled();

  // Kernel log.
  await page.goto('/#/debug/dmesg');
  await expect(page.getByRole('log', { name: 'Kernel log' })).toContainText('usb 1-1', { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test('crash reports: view, download, delete', async ({ paired: page, errors }) => {
  await addRootedTv(page, 'Crash Root');
  await page.goto('/#/debug/crashes');
  await expect(page.getByText('com.example.crashy (4242)')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('surface-manager (1001)')).toBeVisible();
  await page.getByText('com.example.crashy (4242)').click();
  const dialog = page.getByRole('dialog', { name: 'com.example.crashy (4242)' });
  await expect(dialog.locator('pre')).toContainText('Signal: 11 (SIGSEGV)');
  const dl = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download' }).click();
  const file = await dl;
  expect(file.suggestedFilename()).toBe('usr_palm_applications_com.example.crashy_crashy.txt');
  expect(readFileSync(await file.path()).toString()).toContain('Backtrace:');
  await dialog.getByText('Close', { exact: true }).click();

  // Delete one that isn't the app crash (the rig's TV is shared, and a retry finds one fewer).
  const rows = page.locator('.crash-table tbody tr');
  const n = await rows.count();
  const victim = rows.filter({ hasNotText: 'com.example.crashy' }).first();
  const title = (await victim.locator('.crash-title').textContent())!;
  await victim.getByRole('button', { name: `Delete ${title}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(rows).toHaveCount(n - 1);
  await expect(page.getByText(title, { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('luna monitor: capture, filter, details, save and open', async ({ paired: page, errors }) => {
  await addRootedTv(page, 'Luna Root');
  await page.goto('/#/debug/luna');
  await page.getByRole('button', { name: 'Start capture' }).click();
  const list = page.getByRole('log', { name: 'Luna calls' });
  await expect(list).toContainText('com.webos.service.config/getConfigs', { timeout: 30_000 });
  await expect(list).toContainText('com.webos.notification/createToast', { timeout: 15_000 });
  await page.getByLabel(/Filter calls/).fill('destination:com.webos.notification');
  await expect(list.locator('button.log-row').first()).toContainText('createToast');
  await expect(list).not.toContainText('getConfigs');
  await list.locator('button.log-row').first().click();
  const details = page.getByRole('region', { name: 'Call details' });
  await expect(details).toContainText('Hello <b>from</b> the mock TV'); // shown as text, never as HTML
  await details.getByRole('button', { name: /Not allowed/ }).click();
  await expect(details.locator('pre')).toContainText('"returnValue": false');
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('button', { name: 'Capture again' })).toBeVisible();

  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save' }).click();
  const file = await dl;
  expect(file.suggestedFilename()).toMatch(/^Luna-Root-ls-monitor-.*\.jsonl$/);
  const saved = await file.path();
  expect(readFileSync(saved).toString().split('\n')[0]).toMatch(/^\{"senderUniqueName"/);

  // Open it again (works without capturing).
  await page.getByLabel(/Filter calls/).fill('');
  await page.locator('input[type=file]').setInputFiles(saved);
  await expect(page.locator('.log-card .log-status')).toHaveText(basename(saved)); // the file's name
  await expect(list).toContainText('getConfigs');
  expect(errors).toEqual([]);
});

test('Developer Mode: crash reports only', async ({ paired: page, errors }) => {
  await addDevModeTv(page, 'Debug Dev');
  await page.goto('/#/debug/logs');
  await expect(page.getByText('Needs a rooted TV')).toBeVisible();
  await page.goto('/#/debug/crashes');
  await expect(page.getByText('surface-manager (1001)')).toBeVisible({ timeout: 30_000 });
  await page.goto('/#/debug/luna');
  await expect(page.getByText('Capturing needs a rooted TV')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start capture' })).toBeDisabled();
  expect(errors).toEqual([]);
});
