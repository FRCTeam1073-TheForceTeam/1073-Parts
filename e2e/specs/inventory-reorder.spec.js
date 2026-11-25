import { test, expect, uniq } from '../support/fixtures.js';
import { createMember } from '../support/api.js';
import { openTab, rowFor, pickOrdersTab, expectToast } from '../support/ui.js';

test('a mentor turns a low-stock item into a part request for the missing amount', async ({ mentorPage, apiAs }) => {
  const name = uniq('E2E Low Stock');
  // 1 on hand, minimum 4: the reorder suggestion is 3.
  await (await apiAs('mentor')).post('/api/inventory', { data: { name, quantity: 1, min_quantity: 4 } });

  await openTab(mentorPage, 'Inventory');
  await mentorPage.getByRole('button', { name: /^Reorder low stock/ }).click();
  const dialog = mentorPage.getByRole('dialog', { name: 'Reorder low stock' });
  await expect(dialog.getByRole('checkbox', { name: `Reorder ${name}` })).toBeChecked();
  await dialog.getByRole('button', { name: 'Create requests', exact: true }).click();

  await expectToast(mentorPage, 'Created');
  await pickOrdersTab(mentorPage, 'Approved');
  await expect(rowFor(mentorPage, name)).toContainText('3');
});

test('"Order more" opens the request form with the item already filled in', async ({ mentorPage, apiAs }) => {
  const name = uniq('E2E Reorder Me');
  await (await apiAs('mentor')).post('/api/inventory', { data: { name, quantity: 0, min_quantity: 0 } });

  await openTab(mentorPage, 'Inventory');
  await rowFor(mentorPage, name).getByRole('button', { name: 'Order more', exact: true }).click();

  await expect(mentorPage.getByRole('dialog', { name: 'Add part to order' })).toBeVisible();
  await expect(mentorPage.getByLabel('Part name', { exact: true })).toHaveValue(name);
});
