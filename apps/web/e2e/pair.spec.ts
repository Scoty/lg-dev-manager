import { expect, test, TOKEN } from './fixtures';

test('a pairing link pairs this browser in one click, and leaves no token in the address', async ({ page, errors }) => {
  await page.goto('/#/pair?token=e2e-wrong-token');
  await expect(page.getByText('The bridge didn’t accept this link’s token.')).toBeVisible();
  expect(page.url()).not.toContain('token=');
  expect(await page.evaluate(() => localStorage.getItem('lgdm-bridge'))).toBeNull(); // nothing saved

  await page.goto(`/#/pair?token=${TOKEN}`);
  await expect(page).toHaveURL(/#\/devices$/);
  await expect(page.locator('.bridge-pill')).toHaveText('Bridge connected');
  await expect(page.getByText('Paired with the bridge')).toBeVisible();
  const saved = JSON.parse((await page.evaluate(() => localStorage.getItem('lgdm-bridge')))!);
  expect(saved.token).toBe(TOKEN);
  expect(saved.url).toBe(page.url().replace(/^http/, 'ws').replace(/\/#.*$/, '/rpc'));
  expect(errors).toEqual([]);
});
