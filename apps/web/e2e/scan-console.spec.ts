import { addDevModeTvWithWizard, addRootedTv, expect, test } from './fixtures';

test.describe('add-device wizard: rooted first and network scan', () => {
  test('rooted is recommended and preselected', async ({ paired: page }) => {
    await page.goto('/#/devices/new');
    const rooted = page.getByRole('radio', { name: /Rooted \(Homebrew Channel\)/ });
    await expect(rooted).toHaveAttribute('aria-checked', 'true');
    await expect(rooted).toContainText('Recommended');
    await expect(page.getByRole('radio').first()).toHaveAccessibleName(/Rooted/);
  });

  test('finds the TV on the network, and explains that root SSH is off', async ({ paired: page, errors }) => {
    await page.goto('/#/devices/new');
    await page.getByRole('button', { name: 'Next' }).click();
    const found = page.getByRole('option', { name: /127\.0\.0\.1/ });
    await expect(found).toBeVisible({ timeout: 20_000 });
    await expect(found).toContainText('Root SSH off');
    await found.click();
    await expect(page.getByLabel('IP address')).toHaveValue('127.0.0.1');
    await expect(page.getByText('This is an LG TV, but its SSH server is off')).toBeVisible();
    await expect(page.getByText('System reboot')).toBeVisible();
    // Homebrew Channel's placeholder root password is already filled in.
    await expect(page.getByLabel(/Password for/)).toHaveValue('alpine');

    // Trying anyway: the failed login points at the same fix.
    await page.getByRole('button', { name: 'Verify & add' }).click();
    await expect(page.getByText('Couldn’t log in')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('This is an LG TV, but its SSH server is off')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a TV that is already added is marked, not offered again', async ({ paired: page, errors }) => {
    await addRootedTv(page, 'Den TV');
    await page.goto('/#/devices/new');
    await page.getByRole('button', { name: 'Next' }).click();
    const found = page.getByRole('option', { name: /127\.0\.0\.1/ });
    await expect(found).toBeVisible({ timeout: 20_000 });
    await expect(found).toContainText('Already added as Den TV');
    await expect(found).toHaveAttribute('aria-disabled', 'true');
    await found.click({ force: true });
    await expect(page.getByLabel('IP address')).toHaveValue(''); // nothing picked
    // Typing the address by hand still works, with a note.
    await page.getByLabel('IP address').fill('127.0.0.1');
    await expect(page.getByText('This TV is already added as Den TV')).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('console', () => {
  test('shows the commands the bridge runs, and runs typed commands', async ({ paired: page, errors }) => {
    // Through the wizard: the console should show its key-server fetch too.
    await addDevModeTvWithWizard(page, 'Console TV');
    await page.getByRole('button', { name: 'Go to apps' }).click();
    await expect(page.getByText('com.example.hello')).toBeVisible();

    await page.getByRole('button', { name: /^Console/ }).click();
    const dock = page.getByRole('region', { name: 'Console' });
    await expect(dock.getByText(/luna:\/\/com\.webos\.applicationManager\/dev\/listApps/)).toBeVisible();
    await expect(dock.getByText(/GET http:\/\/127\.0\.0\.1:9991\/webos_rsa/)).toBeVisible();
    // Icon reads are hidden unless asked for.
    await expect(dock.getByText(/icon\.png/)).toHaveCount(0);
    await dock.getByText('Background reads').click();
    await expect(dock.getByText(/icon\.png/).first()).toBeVisible();

    await dock.getByText('Send commands').click();
    const input = dock.getByRole('textbox', { name: /Command to run on Console TV/ });
    await input.fill('uname -a');
    await input.press('Enter');
    await expect(dock.getByText(/Linux mock-tv/)).toBeVisible();

    await input.fill('nosuchcmd');
    await input.press('Enter');
    await expect(dock.getByText('exit 127')).toBeVisible();
    await expect(dock.getByText('sh: nosuchcmd: not found')).toBeVisible();

    await input.fill('sleep 100');
    await input.press('Enter');
    await expect(dock.getByRole('button', { name: 'Stop' })).toBeVisible();
    await dock.getByRole('button', { name: 'Stop' }).click();
    await expect(dock.getByText('stopped')).toBeVisible();

    // History: ↑ brings back the last command.
    await input.press('ArrowUp');
    await expect(input).toHaveValue('sleep 100');
    expect(errors).toEqual([]);
  });
});
