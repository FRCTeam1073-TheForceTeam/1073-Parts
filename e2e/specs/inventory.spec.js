import { test, expect, uniq } from '../support/fixtures.js';
import { openTab, rowFor, expectToast } from '../support/ui.js';

test('a mentor adds an item to inventory with a location', async ({ mentorPage }) => {
  const name = uniq('E2E Washer');

  await openTab(mentorPage, 'Inventory');
  await mentorPage.getByRole('button', { name: '+ Add to inventory', exact: true }).click();
  await mentorPage.getByLabel('Part name', { exact: true }).fill(name);
  await mentorPage.getByLabel('Quantity on hand', { exact: true }).fill('5');
  await mentorPage.getByLabel('Location', { exact: true }).fill('Bin 12');
  await mentorPage.getByRole('button', { name: 'Add to inventory', exact: true }).click();

  await expectToast(mentorPage, 'Added to inventory');
  await expect(rowFor(mentorPage, name)).toContainText('Bin 12');
  await expect(rowFor(mentorPage, name)).toContainText('5');
});

test('"Add one" and "Use one" change the count on hand', async ({ mentorPage }) => {
  const name = uniq('E2E Nut');

  await openTab(mentorPage, 'Inventory');
  await mentorPage.getByRole('button', { name: '+ Add to inventory', exact: true }).click();
  await mentorPage.getByLabel('Part name', { exact: true }).fill(name);
  await mentorPage.getByLabel('Quantity on hand', { exact: true }).fill('2');
  await mentorPage.getByRole('button', { name: 'Add to inventory', exact: true }).click();
  await expectToast(mentorPage, 'Added to inventory');

  const row = rowFor(mentorPage, name);
  await row.getByRole('button', { name: 'Add one' }).click();
  await expect(row.locator('.qty-ctl .n')).toHaveText('3');
  await row.getByRole('button', { name: 'Use one' }).click();
  await row.getByRole('button', { name: 'Use one' }).click();
  await expect(row.locator('.qty-ctl .n')).toHaveText('1');
});

test('a mentor edits an item\'s location', async ({ mentorPage }) => {
  const name = uniq('E2E Clamp');

  await openTab(mentorPage, 'Inventory');
  await mentorPage.getByRole('button', { name: '+ Add to inventory', exact: true }).click();
  await mentorPage.getByLabel('Part name', { exact: true }).fill(name);
  await mentorPage.getByLabel('Location', { exact: true }).fill('Old shelf');
  await mentorPage.getByRole('button', { name: 'Add to inventory', exact: true }).click();
  await expectToast(mentorPage, 'Added to inventory');

  await rowFor(mentorPage, name).getByRole('button', { name: 'Edit', exact: true }).click();
  await mentorPage.getByLabel('Location', { exact: true }).fill('New shelf');
  await mentorPage.getByRole('button', { name: 'Save', exact: true }).click();

  await expectToast(mentorPage, 'Saved');
  await expect(rowFor(mentorPage, name)).toContainText('New shelf');
});
