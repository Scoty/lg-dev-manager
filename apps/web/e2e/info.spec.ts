import { readFileSync } from 'node:fs';
import { addDevModeTv, addRootedTv, expect, test } from './fixtures';

/** Device info against the mock TVs and the fake LG Developer Mode service in the rig. */

test('Dev Mode: details, session countdown, renew, automatic renewal', async ({ paired: page, errors }) => {
  await addDevModeTv(page, 'Info Dev');
  await page.goto('/#/info');
  await expect(page.locator('.info-kv')).toContainText('OLED55C36LC', { timeout: 30_000 });
  await expect(page.locator('.info-kv')).toContainText('mock-tv');
  const countdown = page.getByLabel('Time left');
  await expect(countdown).toHaveText(/^\d{3}:\d\d:\d\d$/, { timeout: 30_000 });
  // It ticks.
  const first = await countdown.textContent();
  await expect(countdown).not.toHaveText(first!, { timeout: 5_000 });

  // Renew: LG's timer goes back to ~1000 hours.
  await page.getByRole('button', { name: 'Renew now' }).click();
  await expect(page.getByText('Developer Mode session renewed')).toBeVisible({ timeout: 30_000 });
  await expect(countdown).toHaveText(/^(999|1000):/, { timeout: 15_000 });

  // Automatic renewal: the URL, the script (with the key), IFTTT.
  await page.getByRole('button', { name: 'Renew automatically…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Renew Developer Mode automatically' });
  await expect(dialog.locator('.copybox')).toContainText('https://developer.lge.com/secure/ResetDevModeSession.dev?sessionToken=MOCKDEVMODETOKEN');
  await dialog.getByRole('button', { name: 'Shell script' }).click();
  await expect(dialog.locator('pre')).toContainText("DEVICE_NAME='Info-Dev'");
  await expect(dialog.locator('pre')).toContainText('BEGIN RSA PRIVATE KEY');
  const dl = page.waitForEvent('download');
  await dialog.getByRole('button', { name: /Download renew-devmode-Info-Dev\.sh/ }).click();
  const file = await dl;
  expect(file.suggestedFilename()).toBe('renew-devmode-Info-Dev.sh');
  expect(readFileSync(await file.path()).toString()).toContain('ResetDevModeSession.dev?sessionToken=$SESSION_TOKEN');
  await dialog.getByRole('button', { name: 'IFTTT' }).click();
  await expect(dialog.getByText('Date & Time')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();

  // Screenshots need root.
  await expect(page.getByText('Needs a rooted TV')).toBeVisible();
  expect(errors).toEqual([]);
});

test('rooted: screenshot with a layer choice, and download', async ({ paired: page, errors }) => {
  await addRootedTv(page, 'Info Root');
  await page.goto('/#/info');
  await expect(page.locator('.info-kv')).toContainText('root', { timeout: 30_000 });
  // No Developer Mode card for root; Homebrew Channel is shown instead.
  await expect(page.getByText('Developer Mode', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Homebrew Channel' })).toBeVisible();
  await expect(page.locator('.kv').last()).toContainText('Rooted');

  await page.getByRole('button', { name: 'UI only' }).click();
  await page.getByRole('button', { name: 'Take screenshot' }).click();
  await expect(page.getByAltText('Screenshot of Info Root')).toBeVisible({ timeout: 30_000 });
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  expect((await dl).suggestedFilename()).toMatch(/^Info-Root-\d{4}-\d\d-\d\dT[\d-]+\.png$/);
  expect(errors).toEqual([]);
});
