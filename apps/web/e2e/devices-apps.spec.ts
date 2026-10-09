import { addDevModeTv, addRootedTv, expect, ipkFile, test } from './fixtures';

test.describe('Dev Mode TV', () => {
  test('wizard: port check, wrong passphrase, then success', async ({ paired: page, errors }) => {
    await page.goto('/#/devices/new');
    await page.getByRole('radio', { name: /Developer Mode/ }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('button', { name: /Prepare an LG developer account/ })).toBeVisible();
    await page.getByRole('button', { name: 'Skip' }).click();

    await page.getByLabel('Name').fill('Living room');
    await page.getByLabel('IP address').fill('127.0.0.1');
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.getByText('Developer Mode SSH and the key server both answer.')).toBeVisible();

    // Nothing entered yet: the form says what's missing instead of submitting.
    await page.getByRole('button', { name: 'Verify & add' }).click();
    await expect(page.getByText('Enter the passphrase shown in the Developer Mode app.')).toBeVisible();

    await page.getByLabel('Passphrase').fill('WRONG1');
    await page.getByRole('button', { name: 'Verify & add' }).click();
    await expect(page.getByText('Couldn’t get the key from the TV')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/case-sensitive/).first()).toBeVisible();

    await page.getByRole('button', { name: 'Back to details' }).click();
    await page.getByLabel('Passphrase').fill('A1B2C3');
    await page.getByRole('button', { name: 'Verify & add' }).click();
    await expect(page.getByText('Living room is ready')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('MOCK55TV')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('apps: list, install an IPK, launch, uninstall', async ({ paired: page, errors }) => {
    await addDevModeTv(page, 'Kitchen');
    await page.getByRole('button', { name: 'Go to apps' }).click();
    await expect(page.getByText('com.example.hello')).toBeVisible();
    await expect(page.getByText(/free of/)).toBeVisible();

    const ipk = ipkFile('org.example.e2edev', '1.4.0', 'E2E Dev App');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Install IPK' }).click();
    await (await chooser).setFiles(ipk);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('E2E Dev App v1.4.0 is installed')).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Launch' }).click();
    await expect(page.getByText('Launched E2E Dev App')).toBeVisible();

    await page.getByRole('button', { name: 'More actions for E2E Dev App' }).click();
    await page.getByRole('menuitem', { name: 'Uninstall' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Uninstall' }).click();
    await expect(page.getByText('Uninstalled E2E Dev App')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('org.example.e2edev')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a broken IPK shows the installer error', async ({ paired: page }) => {
    await addDevModeTv(page, 'Office');
    await page.getByRole('button', { name: 'Go to apps' }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Install IPK' }).click();
    await (await chooser).setFiles({ name: 'broken.ipk', mimeType: 'application/octet-stream', buffer: Buffer.from('not a package') });
    await expect(page.getByText('Install failed', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('-1: FAILED_IPKG_INSTALL')).toBeVisible();
  });
});

test.describe('rooted TV with Homebrew Channel', () => {
  test('manual setup, install through Homebrew Channel, guarded hbchannel removal', async ({ paired: page, errors }) => {
    await addRootedTv(page, 'Bedroom');
    await page.getByRole('button', { name: 'Go to apps' }).click();
    await expect(page.getByText('org.webosbrew.hbchannel')).toBeVisible();

    const ipk = ipkFile('org.example.e2eroot', '2.0.0', 'E2E Root App');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Install IPK' }).click();
    await (await chooser).setFiles(ipk);
    await expect(page.getByText('Installed by Homebrew Channel on Bedroom.')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('org.example.e2eroot')).toBeVisible();

    // Removing Homebrew Channel asks twice; cancelling the second keeps it.
    await page.getByRole('button', { name: 'More actions for Homebrew Channel' }).click();
    await page.getByRole('menuitem', { name: 'Uninstall' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Uninstall' }).click();
    await expect(page.getByText('you lose root access immediately')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('org.webosbrew.hbchannel')).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test('devices: switch, edit, remove', async ({ paired: page, errors }) => {
  await addDevModeTv(page, 'TV One');
  await addRootedTv(page, 'TV Two');

  await page.getByRole('button', { name: /Active TV: TV Two/ }).click();
  await page.getByRole('menuitemradio', { name: /TV One/ }).click();
  await expect(page.getByRole('button', { name: /Active TV: TV One/ })).toBeVisible();

  await page.goto('/#/devices');
  await page.getByRole('button', { name: 'Edit TV Two' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('TV Two (bedroom)');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: 'TV Two (bedroom)', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Test connection to TV One' }).click();
  await expect(page.getByText('TV One is reachable')).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'More actions for TV Two (bedroom)' }).click();
  await page.getByRole('menuitem', { name: 'Remove from this browser' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('cell', { name: 'TV Two (bedroom)', exact: true })).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'TV One', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
