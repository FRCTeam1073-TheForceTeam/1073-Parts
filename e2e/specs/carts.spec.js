import { test, expect, uniq } from '../support/fixtures.js';
import { createVendor, createRequest } from '../support/api.js';
import { openTab, pickOrdersTab, rowFor, expectToast } from '../support/ui.js';

// Carts group the "Needed" parts by supplier. For a vendor with no automatic cart, a mentor marks them
// ordered by hand. This doesn't touch any supplier website.
const groupCard = (page, vendor) => page.locator('.card', { has: page.getByRole('heading', { name: vendor, exact: true }) });

test('a mentor marks a vendor\'s parts as ordered, with an order number and tracking', async ({ mentorPage, apiAs }) => {
  const vendor = await createVendor(await apiAs('mentor'), uniq('E2E Cart Vendor'));
  const first = uniq('E2E Cart Part A');
  const second = uniq('E2E Cart Part B');
  await createRequest(await apiAs('student'), { name: first, supplier: vendor });
  await createRequest(await apiAs('student'), { name: second, supplier: vendor });

  await openTab(mentorPage, 'Carts');
  const card = groupCard(mentorPage, vendor);
  await card.getByRole('button', { name: 'Mark all ordered…', exact: true }).click();

  const dialog = mentorPage.getByRole('dialog');
  await dialog.getByLabel('Supplier order #', { exact: true }).fill('PO-4471');
  await dialog.getByLabel('Tracking #', { exact: true }).fill('1Z999AA10123456784');
  await dialog.getByRole('button', { name: 'Mark ordered', exact: true }).click();

  await expectToast(mentorPage, 'Marked 2 parts ordered');
  await openTab(mentorPage, 'Orders');
  await pickOrdersTab(mentorPage, 'Ordered');
  await expect(rowFor(mentorPage, first)).toBeVisible();
  await expect(rowFor(mentorPage, second)).toBeVisible();
});

test('a student sees the carts but cannot mark anything ordered', async ({ studentPage, apiAs }) => {
  const vendor = await createVendor(await apiAs('mentor'), uniq('E2E Cart Student'));
  await createRequest(await apiAs('student'), { name: uniq('E2E Cart Student Part'), supplier: vendor });

  await openTab(studentPage, 'Carts');
  const card = groupCard(studentPage, vendor);
  await expect(card).toBeVisible();
  await expect(studentPage.getByText('A mentor places the orders.')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Mark all ordered…', exact: true })).toHaveCount(0);
});
