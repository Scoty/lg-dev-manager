import { expect, test, TOKEN } from './fixtures';

test('a pairing link pairs this browser in one click, and leaves no token in the address', async ({ page, errors }) => {
  await page.goto('/#/pair?token=e2e-wrong-token');
  // Nothing is tried until the click: a website opening a link can't make this browser try tokens.
  await expect(page.getByText('This browser will use the bridge at')).toBeVisible();
  await expect(page).not.toHaveURL(/token=/);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByText('The bridge didn’t accept this link’s token.')).toBeVisible();
  expect(page.url()).not.toContain('token=');
  expect(await page.evaluate(() => localStorage.getItem('lgdm-bridge'))).toBeNull(); // nothing saved

  await page.goto(`/#/pair?token=${TOKEN}`);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page).toHaveURL(/#\/devices$/);
  await expect(page.locator('.bridge-pill')).toHaveText('Bridge connected');
  await expect(page.getByText('Paired with the bridge')).toBeVisible();
  const saved = JSON.parse((await page.evaluate(() => localStorage.getItem('lgdm-bridge')))!);
  expect(saved.token).toBe(TOKEN);
  expect(saved.url).toBe(page.url().replace(/^http/, 'ws').replace(/\/#.*$/, '/rpc'));
  expect(errors).toEqual([]);
});
