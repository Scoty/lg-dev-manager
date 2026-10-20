import type { Browser, Page } from '@playwright/test';
import { addRootedTvWithWizard, expect, test, TOKEN } from './fixtures';

/**
 * A bridge that stores the TVs itself (2.0, --store; the Docker image): every paired browser sees the same TVs,
 * custom repositories and screenshots, and the TVs' logins never come back to a browser. The rig runs it on 5295.
 */
const STORE = `http://127.0.0.1:${process.env.E2E_STORE_BRIDGE_PORT ?? 5295}`;
test.use({ baseURL: STORE });
test.describe.configure({ mode: 'serial' });

/** Another browser (its own storage), paired with the storing bridge. */
async function otherBrowser(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: STORE });
  const page = await context.newPage();
  await page.addInitScript(([url, token]) => localStorage.setItem('lgdm-bridge', JSON.stringify({ url, token })), [`${STORE.replace(/^http/, 'ws')}/rpc`, TOKEN] as const);
  return page;
}

/** Everything this page has stored itself (localStorage + IndexedDB), as text. */
const ownStorage = (page: Page) =>
  page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('lgdm');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const devices = await new Promise<unknown[]>((resolve) => {
      const r = db.transaction('devices').objectStore('devices').getAll();
      r.onsuccess = () => resolve(r.result);
    });
    db.close();
    return JSON.stringify({ local: { ...localStorage }, devices });
  });

test('every browser paired with it sees the same TVs, and never gets their logins', async ({ paired: page, browser, errors }) => {
  await page.goto('/#/devices');
  await expect(page.getByRole('heading', { name: 'Your TVs are stored on the bridge' })).toBeVisible();
  await addRootedTvWithWizard(page, 'Shared TV');

  const other = await otherBrowser(browser);
  await other.goto('/#/devices');
  await expect(other.locator('.data-cell-user-name').getByText('Shared TV', { exact: true })).toBeVisible();
  await other.locator('tr', { hasText: 'Shared TV' }).getByRole('button', { name: 'Make active' }).click();
  // Calls on a stored TV work by its id: the bridge fills in the login.
  await other.goto('/#/info');
  await expect(other.getByText('OLED55C36LC')).toBeVisible({ timeout: 30_000 });
  await other.goto('/#/devices');
  await expect(other.locator('td', { hasText: 'root · password' })).toBeVisible();
  // Neither browser keeps the password ("alpine") anywhere.
  for (const p of [page, other]) expect(await ownStorage(p)).not.toContain('alpine');

  // Renaming keeps the stored login; the first browser sees the new name without a reload.
  await page.goto('/#/devices');
  await expect(page.locator('.data-cell-user-name').getByText('Shared TV', { exact: true })).toBeVisible();
  await other.getByRole('button', { name: 'Edit Shared TV' }).click();
  await other.getByLabel('Name').fill('Shared TV (renamed)');
  await other.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.data-cell-user-name').getByText('Shared TV (renamed)', { exact: true })).toBeVisible();
  await other.goto('/#/info');
  await expect(other.getByText('OLED55C36LC')).toBeVisible({ timeout: 30_000 });
  await other.context().close();
  expect(errors).toEqual([]);
});

test('a browser’s own TVs from before move to the bridge', async ({ paired: page, errors }) => {
  await page.goto('/#/devices');
  await expect(page.getByRole('heading', { name: 'Your TVs are stored on the bridge' })).toBeVisible();
  // A TV this browser saved itself, before the bridge stored them.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('lgdm');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise<void>((resolve) => {
      const t = db.transaction('devices', 'readwrite');
      const now = Date.now();
      t.objectStore('devices').put({ id: 'own-tv-1', name: 'Old Browser TV', mode: 'rooted', host: '127.0.0.1', port: 2222, username: 'root', auth: { kind: 'password', password: 'alpine' }, createdAt: now, updatedAt: now });
      t.oncomplete = () => resolve();
    });
    db.close();
  });
  await page.reload();
  await expect(page.getByText('This browser also has 1 TV of its own')).toBeVisible();
  await page.getByRole('button', { name: 'Move to the bridge' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Move them' }).click();
  await expect(page.getByText('Moved 1 TV to the bridge.')).toBeVisible();
  await expect(page.locator('.data-cell-user-name').getByText('Old Browser TV', { exact: true })).toBeVisible();
  await expect(page.getByText('This browser also has')).toHaveCount(0);
  expect(await ownStorage(page)).not.toContain('alpine');
  expect(errors).toEqual([]);
});

test('custom repositories and screenshots are shared too', async ({ paired: page, browser, errors }) => {
  // The TV from the first test is stored on the bridge; make it this browser's active one.
  await page.goto('/#/devices');
  const row = page.locator('tr', { hasText: 'Shared TV (renamed)' });
  await expect(row).toBeVisible();
  if (await row.getByRole('button', { name: 'Make active' }).count()) await row.getByRole('button', { name: 'Make active' }).click();

  const other = await otherBrowser(browser);
  await other.goto('/#/repos');
  await other.getByLabel('Repository address').fill(`http://127.0.0.1:${process.env.E2E_CUSTOM_REPO_PORT ?? 5296}/api`);
  await other.getByLabel(/^Name/).fill('Shared repo');
  await other.locator('label.check', { hasText: 'I understand that apps from this repository' }).click();
  await other.getByRole('button', { name: 'Check & add' }).click();
  await expect(other.getByText('Shared repo added')).toBeVisible({ timeout: 30_000 });
  // The first browser has it in its sidebar.
  await page.locator('.d-sidebar').getByRole('button', { name: 'Apps' }).click();
  await expect(page.locator('.d-sidebar').getByRole('link', { name: 'Shared repo' })).toBeVisible();

  // A screenshot taken in one browser shows in the other.
  await page.goto('/#/info');
  await page.getByRole('button', { name: 'Take screenshot' }).click();
  await expect(page.getByRole('button', { name: 'Delete this screenshot' })).toBeVisible({ timeout: 30_000 });
  await other.goto('/#/devices');
  const otherRow = other.locator('tr', { hasText: 'Shared TV (renamed)' });
  await expect(otherRow).toBeVisible();
  if (await otherRow.getByRole('button', { name: 'Make active' }).count()) await otherRow.getByRole('button', { name: 'Make active' }).click();
  await other.goto('/#/info');
  await expect(other.getByRole('button', { name: 'Delete this screenshot' })).toBeVisible({ timeout: 30_000 });
  await other.context().close();
  expect(errors).toEqual([]);
});
