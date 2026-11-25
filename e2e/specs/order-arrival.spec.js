import { test, expect, uniq } from '../support/fixtures.js';
import { createVendor, createRequest } from '../support/api.js';
import { openTab, pickOrdersTab, rowFor, expectToast } from '../support/ui.js';

test('a mentor marks an approved part as arrived without adding it to inventory', async ({ mentorPage, apiAs }) => {
  const vendor = await createVendor(await apiAs('mentor'));
  const name = uniq('E2E Arrived');
  await createRequest(await apiAs('student'), { name, supplier: vendor });

  await openTab(mentorPage, 'Orders');
  await pickOrdersTab(mentorPage, 'Approved');
  await rowFor(mentorPage, name).getByRole('button', { name: 'Receive', exact: true }).click();
  await mentorPage.getByRole('dialog').getByRole('button', { name: 'Just mark arrived', exact: true }).click();

  await pickOrdersTab(mentorPage, 'Arrived');
  await expect(rowFor(mentorPage, name)).toBeVisible();
  await openTab(mentorPage, 'Inventory');
  await expect(mentorPage.getByRole('row').filter({ hasText: name })).toHaveCount(0);
});
