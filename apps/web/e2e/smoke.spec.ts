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
  ['/apps/litefin', /Litefin\s*repo/],
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
        await expect(page.locator('.phone-notice')).toHaveCount(0); // desktop: no "use a computer" notice
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

test.describe('on a phone', () => {
  test.use({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test('says to use a computer instead', async ({ paired: page, errors }) => {
    await page.goto('/#/devices');
    const notice = page.locator('.phone-notice');
    await expect(notice).toContainText('Use a computer for this');
    await expect(notice).toContainText('risky');
    await notice.getByRole('button', { name: 'Got it' }).click();
    await expect(notice).toHaveCount(0);
    await page.goto('/#/apps/installed');
    await expect(page.locator('h1')).toHaveText(/Installed\s*apps/);
    await expect(page.locator('.phone-notice')).toHaveCount(0); // stays hidden for the session
    // The bridge setup page always says it.
    await page.goto('/#/bridge');
    await expect(page.locator('.phone-notice')).toContainText('desktop or laptop');
    await expect(page.locator('.phone-notice').getByRole('button', { name: 'Got it' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
