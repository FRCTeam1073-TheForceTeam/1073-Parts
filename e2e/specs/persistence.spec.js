import { test, expect, uniq } from '../support/fixtures.js';
import { createVendor } from '../support/api.js';
import { openTab, rowFor, fillPartForm, expectToast } from '../support/ui.js';

// Things that should still be there after a reload: the signed-in session, the tab, a saved request,
// and the theme choice (stored on this browser).

test('a request added in the form is still there after a reload', async ({ studentPage, apiAs }) => {
  const vendor = await createVendor(await apiAs('student'));
  const name = uniq('E2E Reload');

  await openTab(studentPage, 'Orders');
  await studentPage.getByRole('button', { name: '+ Add part', exact: true }).click();
  await fillPartForm(studentPage, { name, supplierName: vendor, quantity: 2, price: 3 });
  await studentPage.getByRole('button', { name: 'Add part', exact: true }).click();
  await expectToast(studentPage, 'Part added');

  await studentPage.reload();

  await expect(rowFor(studentPage, name)).toBeVisible();
  await expect(studentPage.getByRole('banner').getByText('E2E Student')).toBeVisible();
});

test('the page opens on the tab that was open last', async ({ mentorPage }) => {
  await openTab(mentorPage, 'Budget');
  await expect(mentorPage.getByRole('navigation').getByRole('button', { name: /^Budget/ })).toHaveClass(/active/);

  await mentorPage.reload();

  await expect(mentorPage.getByRole('navigation').getByRole('button', { name: /^Budget/ })).toHaveClass(/active/);
});

test('a theme chosen in Settings is kept after a reload', async ({ studentPage }) => {
  await openTab(studentPage, 'Settings');
  await studentPage.getByRole('button', { name: /Dark/ }).click();
  await expect(studentPage.locator('html')).toHaveAttribute('data-theme', 'dark');

  await studentPage.reload();

  await expect(studentPage.locator('html')).toHaveAttribute('data-theme', 'dark');
  // Put it back, so this browser context's default is not changed for later tests in this file.
  await openTab(studentPage, 'Settings');
  await studentPage.getByRole('button', { name: /Auto/ }).click();
});
