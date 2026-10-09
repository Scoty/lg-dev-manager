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

/** Run the add-device wizard for the Dev Mode mock TV (for tests about the wizard or what it leaves behind). */
export async function addDevModeTvWithWizard(page: Page, name: string) {
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
export async function addRootedTvWithWizard(page: Page, name: string, port = ROOTED_PORT) {
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

let devModeKey: Promise<string> | null = null;
/** The Dev Mode mock TV's private key, from its key server (what the wizard fetches). */
function fetchDevModeKey(): Promise<string> {
  devModeKey ??= fetch('http://127.0.0.1:9991/webos_rsa').then(async (r) => {
    if (!r.ok) throw new Error(`key server: HTTP ${r.status}`);
    return r.text();
  });
  return devModeKey;
}

interface SeedDevice {
  name: string;
  mode: 'devmode' | 'rooted';
  port: number;
  username: string;
  auth: { kind: 'key'; privateKey: string; passphrase?: string } | { kind: 'password'; password: string };
}

/**
 * Save a TV straight into the browser's device store and make it the active one — what the wizard ends with,
 * without its ~3 s of checks. Leaves the page on Devices. Tests about the wizard itself use the *WithWizard helpers.
 */
async function seedDevice(page: Page, device: SeedDevice) {
  await page.goto('/#/devices');
  await page.evaluate(async (d) => {
    // Wait for the app to have created its database (it opens it on start).
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      const dbs = await indexedDB.databases();
      ready = dbs.some((x) => x.name === 'lgdm' && (x.version ?? 0) >= 2);
      if (!ready) await new Promise((r) => setTimeout(r, 50));
    }
    if (!ready) throw new Error('seedDevice: the app did not create its "lgdm" IndexedDB database (version ≥ 2) within 5 s — did the page load?');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('lgdm');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const now = Date.now();
    const id = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction('devices', 'readwrite');
      t.objectStore('devices').put({ ...d, id, host: '127.0.0.1', createdAt: now, updatedAt: now });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    db.close();
    localStorage.setItem('lgdm-active-device', id);
  }, device);
  await page.reload();
  await expect(page.locator('.data-cell-user-name').getByText(device.name, { exact: true })).toBeVisible();
}

/** Add the Dev Mode mock TV (port 9922, key from its key server) and make it active. */
export async function addDevModeTv(page: Page, name: string) {
  const privateKey = await fetchDevModeKey();
  await seedDevice(page, { name, mode: 'devmode', port: 9922, username: 'prisoner', auth: { kind: 'key', privateKey, passphrase: PASSPHRASE } });
}

/** Add a rooted mock TV (root / alpine) and make it active. */
export async function addRootedTv(page: Page, name: string, port = ROOTED_PORT) {
  await seedDevice(page, { name, mode: 'rooted', port, username: 'root', auth: { kind: 'password', password: 'alpine' } });
}
