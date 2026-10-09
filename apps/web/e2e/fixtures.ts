import { test as base, expect, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeIpk } from '@lgdm/mock-tv';

export const TOKEN = 'e2e-token';
export const PASSPHRASE = 'A1B2C3';
export const ROOTED_PORT = 2222;
export const NO_PTY_PORT = 2223;

/** Collects console errors and uncaught exceptions so tests can assert a page is clean. */
export const test = base.extend<{ errors: string[]; paired: Page }>({
  errors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));
    await use(errors);
  },
  /** A page already paired with the rig's bridge (same origin, so the default bridge URL works). */
  paired: async ({ page, baseURL }, use) => {
    await page.addInitScript(
      ([url, token]) => localStorage.setItem('lgdm-bridge', JSON.stringify({ url, token })),
      [`${baseURL!.replace(/^http/, 'ws')}/rpc`, TOKEN] as const,
    );
    await use(page);
  },
});
export { expect };

export function setTheme(page: Page, theme: 'light' | 'dark') {
  return page.addInitScript((t) => localStorage.setItem('lgdm-theme', t), theme);
}

/** Write a small real IPK (ar + control.tar.gz) to a temp file and return its path. */
export function ipkFile(id: string, version: string, title: string, padBytes = 200_000): string {
  const dir = mkdtempSync(join(tmpdir(), 'lgdm-ipk-'));
  const path = join(dir, `${id}.ipk`);
  writeFileSync(path, fakeIpk(id, version, title, padBytes));
  return path;
}

/** Open the wizard the way a user does (from Devices), so it starts fresh even if it was just used. */
async function openWizard(page: Page) {
  await page.goto('/#/devices');
  await page.getByRole('link', { name: 'Add a TV' }).first().click();
  await expect(page.getByRole('radio', { name: /Developer Mode/ })).toBeVisible();
}

/** Run the add-device wizard for the Dev Mode mock TV. */
export async function addDevModeTv(page: Page, name: string) {
  await openWizard(page);
  await page.getByRole('radio', { name: /Developer Mode/ }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Skip' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('IP address').fill('127.0.0.1');
  await page.getByLabel('Passphrase').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Verify & add' }).click();
  await expect(page.getByText(`${name} is ready`)).toBeVisible({ timeout: 30_000 });
}

/** Run the add-device wizard ("Set up manually") for the rooted mock TV. */
export async function addRootedTv(page: Page, name: string, port = ROOTED_PORT) {
  await openWizard(page);
  await page.getByRole('radio', { name: /Set up manually/ }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('IP address').fill('127.0.0.1');
  await page.getByLabel('SSH port').fill(String(port));
  await page.getByRole('radio', { name: 'Password' }).click();
  await page.getByLabel(/Password for/).fill('alpine');
  await page.getByRole('button', { name: 'Verify & add' }).click();
  await expect(page.getByText(`${name} is ready`)).toBeVisible({ timeout: 30_000 });
}
