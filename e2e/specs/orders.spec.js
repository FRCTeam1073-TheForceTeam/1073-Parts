import { test, expect, uniq } from '../support/fixtures.js';
import { createVendor, createRequest } from '../support/api.js';
import { openTab, rowFor, pickOrdersTab, fillPartForm, expectToast } from '../support/ui.js';

// These tests run with approval off (the default), so a request goes straight to "Approved".
// The approval flow is in orders-approval.spec.js, which turns approval on.

test('a student adds a part request and sees it in the list', async ({ studentPage, apiAs }) => {
  const vendor = await createVendor(await apiAs('student'));
  const name = uniq('E2E Bracket');

  await openTab(studentPage, 'Orders');
  await studentPage.getByRole('button', { name: '+ Add part', exact: true }).click();
  await fillPartForm(studentPage, { name, supplierName: vendor, quantity: 3, price: 4.5 });
  await studentPage.getByRole('button', { name: 'Add part', exact: true }).click();

  await expectToast(studentPage, 'Part added');
  await expect(rowFor(studentPage, name)).toContainText('3');
});

test('a student edits the quantity of their own request', async ({ studentPage, apiAs }) => {
  const vendor = await createVendor(await apiAs('student'));
  const name = uniq('E2E Spacer');
  await createRequest(await apiAs('student'), { name, supplier: vendor, quantity: 1 });

  await openTab(studentPage, 'Orders');
  await rowFor(studentPage, name).getByRole('button', { name: 'Edit', exact: true }).click();
  await studentPage.getByLabel('Quantity needed', { exact: true }).fill('7');
  await studentPage.getByRole('button', { name: 'Save', exact: true }).click();

  await expectToast(studentPage, 'Saved');
  await expect(rowFor(studentPage, name)).toContainText('7');
});

test('a student deletes their own request after confirming', async ({ studentPage, apiAs }) => {
  const vendor = await createVendor(await apiAs('student'));
  const name = uniq('E2E Scrap');
  await createRequest(await apiAs('student'), { name, supplier: vendor });

  await openTab(studentPage, 'Orders');
  studentPage.once('dialog', (dialog) => dialog.accept());
  await rowFor(studentPage, name).getByRole('button', { name: 'Delete', exact: true }).click();

  await expectToast(studentPage, 'Part removed');
  await expect(rowFor(studentPage, name)).toHaveCount(0);
});

test('a mentor receives an approved part into inventory with a location', async ({ mentorPage, apiAs }) => {
  const vendor = await createVendor(await apiAs('mentor'));
  const name = uniq('E2E Bolt');
  await createRequest(await apiAs('student'), { name, supplier: vendor, quantity: 4 });

  await openTab(mentorPage, 'Orders');
  await pickOrdersTab(mentorPage, 'Approved');
  await rowFor(mentorPage, name).getByRole('button', { name: 'Receive', exact: true }).click();
  await mentorPage.getByLabel('Quantity received', { exact: true }).fill('4');
  await mentorPage.getByLabel('Storage location', { exact: true }).fill('Shelf A');
  await mentorPage.getByRole('button', { name: 'Add to inventory', exact: true }).click();

  await expectToast(mentorPage, 'Added to inventory');
  await openTab(mentorPage, 'Inventory');
  await expect(rowFor(mentorPage, name)).toContainText('Shelf A');
});

test('the CSV export lists the requests with their names', async ({ apiAs }) => {
  const admin = await apiAs('admin');
  const name = uniq('E2E Export');
  await createRequest(await apiAs('student'), { name });

  const res = await admin.get('/api/orders.csv');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/csv');
  expect(await res.text()).toContain(name);
});
