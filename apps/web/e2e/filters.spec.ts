import { addRootedTv, expect, test } from './fixtures';

/**
 * The "More" menu (MoreFilters) on the repository and Installed pages: extra filters and the sort order behind one
 * button, next to the main tabs. Reads only: the rooted mock TV is shared with other specs.
 */
const card = (page: import('@playwright/test').Page, title: string) => page.locator('.repo-card', { has: page.getByRole('button', { name: `Details for ${title}`, exact: true }) });
const row = (page: import('@playwright/test').Page, title: string) => page.locator('.apps-table tbody tr', { hasText: title });

test('repository: filter by root, type and install state, sort, and clear', async ({ paired: page, errors }) => {
  await addRootedTv(page, 'Filters TV');
  await page.goto('/#/apps/homebrew');
  await expect(card(page, 'Repo Example')).toBeVisible({ timeout: 30_000 });
  const more = page.getByRole('button', { name: /^More filters and sort order/ });
  const menu = page.getByRole('menu', { name: 'More filters and sort order' });

  await more.click();
  await menu.getByRole('menuitemradio', { name: /Needs root/ }).click();
  await expect(page.locator('.repo-card')).toHaveCount(1);
  await expect(card(page, 'Root Only Tool')).toBeVisible();
  await expect(more).toHaveAccessibleName('More filters and sort order, 1 set');
  // Nothing is both: the page says so and clears the filters (not the order) in one click.
  await menu.getByRole('menuitemradio', { name: /Native apps/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByText('No app matches the search and the filters in More.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear the filters' }).click();
  await expect(card(page, 'Repo Example')).toBeVisible();

  await more.click();
  await menu.getByRole('menuitemradio', { name: /Native apps/ }).click();
  await expect(page.locator('.repo-card')).toHaveCount(1);
  await expect(card(page, 'Moonlight')).toBeVisible();
  await menu.getByRole('button', { name: 'Reset' }).click();
  await menu.getByRole('menuitemradio', { name: /Name \(Z–A\)/ }).click();
  await expect(page.locator('.repo-card').first()).toContainText('YouTube AdFree');
  await menu.getByRole('menuitemradio', { name: /Name \(A–Z\)/ }).click();
  await page.keyboard.press('Escape');

  // "Not installed" can't hold with the Installed tab: back to All.
  await page.getByRole('button', { name: /^Installed/ }).click();
  await more.click();
  await menu.getByRole('menuitemradio', { name: /Not installed/ }).click();
  await expect(page.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(card(page, 'Moonlight')).toHaveCount(0);
  await expect(card(page, 'Repo Example')).toBeVisible();
  expect(errors).toEqual([]);
});

test('installed apps: filter by type and updates, sort', async ({ paired: page, errors }) => {
  await addRootedTv(page, 'Filters TV');
  await page.goto('/#/apps/installed');
  await expect(row(page, 'Moonlight')).toBeVisible({ timeout: 30_000 });
  const more = page.getByRole('button', { name: /^More filters and sort order/ });
  const menu = page.getByRole('menu', { name: 'More filters and sort order' });

  await more.click();
  await menu.getByRole('menuitemradio', { name: /Native apps/ }).click();
  await expect(row(page, 'Moonlight')).toBeVisible();
  await expect(row(page, 'Hello World')).toHaveCount(0);
  await menu.getByRole('menuitemradio', { name: /Web apps/ }).click();
  await expect(row(page, 'Hello World')).toBeVisible();
  await expect(row(page, 'Moonlight')).toHaveCount(0);

  await menu.getByRole('button', { name: 'Reset' }).click();
  await menu.getByRole('menuitemradio', { name: /Updates available/ }).click();
  await expect(row(page, 'Hello World')).toHaveCount(0); // not in the repository: never an update
  await expect(row(page, 'Moonlight')).toHaveCount(0); // up to date
  await menu.getByRole('button', { name: 'Reset' }).click();
  await menu.getByRole('menuitemradio', { name: /Name \(Z–A\)/ }).click();
  await page.keyboard.press('Escape');
  const titles = await page.locator('.apps-table tbody .data-cell-user-name').allTextContents();
  expect(titles).toEqual([...titles].sort((a, b) => b.localeCompare(a)));
  expect(errors).toEqual([]);
});
