import { expect, setTheme, test } from './fixtures';

/** Every page renders in light and dark without console errors (AGENTS.md → Testing expectations). */
const PAGES = [
  '/bridge',
  '/devices',
  '/devices/new',
  '/apps/installed',
  '/apps/homebrew',
  '/files',
  '/terminal',
  '/info',
  '/debug/logs',
  '/debug/pmlog',
  '/debug/dmesg',
  '/debug/crashes',
  '/debug/luna',
];

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} theme`, () => {
    for (const path of PAGES) {
      test(`renders ${path}`, async ({ paired: page, errors }) => {
        await setTheme(page, theme);
        await page.goto(`/#${path}`);
        await expect(page.getByText('Bridge connected')).toBeVisible();
        await expect(page.locator('h1')).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        expect(errors).toEqual([]);
      });
    }
  });
}

test('pairs from the bridge page', async ({ page, errors }) => {
  await page.goto('/#/bridge');
  await page.getByLabel('Pairing token').fill('e2e-token');
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page.getByText('Bridge connected')).toBeVisible();
  expect(errors).toEqual([]);
});

test('apps page explains what is missing without a TV', async ({ paired: page }) => {
  await page.goto('/#/apps/installed');
  await expect(page.getByRole('heading', { name: 'Add your TV' })).toBeVisible();
});
