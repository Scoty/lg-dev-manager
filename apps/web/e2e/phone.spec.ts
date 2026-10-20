import { addRootedTv, expect, test } from './fixtures';

/** Phones and tablets use the app through a bridge on the network (2.0, Docker): every page has to fit and work. */
test.use({
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

const PAGES = [
  '/bridge', '/devices', '/devices/new', '/apps/installed', '/apps/homebrew', '/apps/litefin', '/repos', '/files', '/terminal',
  '/info', '/debug/logs', '/debug/pmlog', '/debug/dmesg', '/debug/crashes', '/debug/luna',
];

test('every page fits a phone screen — nothing wider than it', async ({ paired: page, errors }) => {
  await addRootedTv(page, 'Phone Sized TV');
  for (const path of PAGES) {
    await test.step(path, async () => {
      await page.goto(`/#${path}`);
      await expect(page.locator('h1')).toBeVisible();
      const wide = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.content *'))
          // Inside something that scrolls sideways on purpose (tables, terminal tabs, the key bar) is fine.
          .filter((e) => !e.closest('.table-scroll, .term-tabs, .term-keys, .xterm, .seg, pre, .codeblock'))
          .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
          .slice(0, 3)
          .map((e) => `${e.tagName.toLowerCase()}.${Array.from(e.classList).join('.')}`),
      );
      expect(wide, `${path}: elements wider than the screen`).toEqual([]);
    });
  }
  expect(errors).toEqual([]);
});

test('the terminal has the keys a phone keyboard lacks', async ({ paired: page, errors }) => {
  await addRootedTv(page, 'Phone Terminal TV');
  await page.goto('/#/terminal');
  await page.getByRole('button', { name: /Open a terminal on/ }).click();
  const keys = page.getByRole('toolbar', { name: 'Extra keys' });
  await expect(keys).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.xterm-rows')).toContainText('#', { timeout: 20_000 });
  // Typed on the phone's keyboard, then a key it doesn't have, from the bar.
  await page.locator('.xterm-helper-textarea').pressSequentially('echo phone-');
  await keys.getByRole('button', { name: 'Ctrl+C: stop the running command' }).click();
  await expect(page.locator('.xterm-rows')).toContainText('^C');
  expect(errors).toEqual([]);
});
