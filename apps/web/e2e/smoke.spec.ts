import { expect, setTheme, test } from './fixtures';

/**
 * Every page renders in light and dark without console errors (AGENTS.md → Testing expectations).
 * One test per theme walks all pages in the same tab (hash navigation, like a user clicking through), instead of
 * a fresh browser per page — same checks, a fraction of the time.
 */
const PAGES: [path: string, heading: RegExp][] = [
  ['/bridge', /Connect the\s*bridge/],
  ['/devices', /^Devices/],
  ['/devices/new', /Add a\s*TV/],
  ['/apps/installed', /Installed\s*apps/],
  ['/apps/homebrew', /Homebrew\s*repository/],
  ['/files', /^Files/],
  ['/terminal', /^Terminal/],
  ['/info', /Device\s*info/],
  ['/debug/logs', /System\s*log/],
  ['/debug/pmlog', /Log\s*levels/],
  ['/debug/dmesg', /Kernel\s*log/],
  ['/debug/crashes', /Crash\s*reports/],
  ['/debug/luna', /Luna\s*monitor/],
];

for (const theme of ['light', 'dark'] as const) {
  test(`every page renders in the ${theme} theme`, async ({ paired: page, errors }) => {
    await setTheme(page, theme);
    for (const [path, heading] of PAGES) {
      await test.step(path, async () => {
        await page.goto(`/#${path}`);
        await expect(page.locator('h1')).toHaveText(heading);
        await expect(page.getByText('Bridge connected')).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        expect(errors, `console errors on ${path}`).toEqual([]);
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
