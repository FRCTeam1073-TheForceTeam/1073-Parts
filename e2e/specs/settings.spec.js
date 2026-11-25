import { test, expect, uniq } from '../support/fixtures.js';
import { openTab, expectToast, expectInputValue } from '../support/ui.js';

test('an admin adds a team member through the dialog', async ({ adminPage }) => {
  const display = uniq('E2E Newbie');
  const username = uniq('e2e-newbie').toLowerCase();

  await openTab(adminPage, 'Settings');
  await adminPage.getByRole('button', { name: '+ Add member', exact: true }).click();
  const dialog = adminPage.getByRole('dialog', { name: 'Add team member' });
  await dialog.getByLabel('Name', { exact: true }).fill(display);
  await dialog.getByLabel('Username', { exact: true }).fill(username);
  await dialog.getByLabel('Temporary password', { exact: true }).fill('temp-pass-123');
  await dialog.getByRole('button', { name: 'Create account', exact: true }).click();

  await expectToast(adminPage, 'Account created');
  await expect(adminPage.getByText(display, { exact: true })).toBeVisible();
});

test('a mentor adds a mechanism', async ({ mentorPage }) => {
  const name = uniq('E2E Hood');

  await openTab(mentorPage, 'Settings');
  const card = mentorPage.locator('.card', { has: mentorPage.getByRole('heading', { name: 'Mechanisms', exact: true }) });
  await card.getByPlaceholder('New mechanism (e.g. Hood)').fill(name);
  await card.getByRole('button', { name: 'Add', exact: true }).click();

  await expectInputValue(mentorPage.getByRole('textbox', { name: 'Name', exact: true }), name);
});

test('an admin adds a vendor to the list', async ({ adminPage }) => {
  const name = uniq('E2E Supplier');

  await openTab(adminPage, 'Settings');
  const card = adminPage.locator('.card', { has: adminPage.getByRole('heading', { name: 'Other vendors', exact: true }) });
  await card.getByPlaceholder('Vendor name (e.g. Misumi, Amazon, local metal shop)').fill(name);
  await card.getByRole('button', { name: 'Add', exact: true }).click();

  await expectInputValue(adminPage.getByRole('textbox', { name: 'Vendor name', exact: true }), name);
});

test('an admin downloads a backup file', async ({ adminPage }) => {
  await openTab(adminPage, 'Settings');
  const downloadPromise = adminPage.waitForEvent('download');
  await adminPage.getByRole('link', { name: 'Download backup', exact: true }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/^parts-backup-.*\.tar$/);
});
