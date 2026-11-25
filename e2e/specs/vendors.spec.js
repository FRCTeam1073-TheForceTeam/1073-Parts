import { test, expect, uniq } from '../support/fixtures.js';
import { createVendor } from '../support/api.js';
import { openTab } from '../support/ui.js';

// Vendor names in the "Other vendors" list, in order. Each row's name, Website and Remove controls line up by index.
async function vendorNames(page) {
  return page.getByRole('textbox', { name: 'Vendor name', exact: true }).evaluateAll((els) => els.map((e) => e.value));
}
const vendorsCard = (page) => page.locator('.card', { has: page.getByRole('heading', { name: 'Other vendors', exact: true }) });

test('a mentor renames a vendor, and the new name is saved', async ({ mentorPage, apiAs }) => {
  const oldName = await createVendor(await apiAs('mentor'), uniq('E2E Vendor Old'));
  const newName = uniq('E2E Vendor New');

  await openTab(mentorPage, 'Settings');
  await expect.poll(() => vendorNames(mentorPage)).toContain(oldName);
  const index = (await vendorNames(mentorPage)).indexOf(oldName);
  const input = mentorPage.getByRole('textbox', { name: 'Vendor name', exact: true }).nth(index);
  await input.fill(newName);
  await input.press('Tab');

  await expect(mentorPage.locator('#toast')).toContainText('Renamed');
  await expect.poll(() => vendorNames(mentorPage)).toContain(newName);
  await expect.poll(() => vendorNames(mentorPage)).not.toContain(oldName);
});

test('a mentor removes a vendor from the list after confirming', async ({ mentorPage, apiAs }) => {
  const name = await createVendor(await apiAs('mentor'), uniq('E2E Vendor Gone'));

  await openTab(mentorPage, 'Settings');
  await expect.poll(() => vendorNames(mentorPage)).toContain(name);
  const index = (await vendorNames(mentorPage)).indexOf(name);
  mentorPage.once('dialog', (dialog) => dialog.accept());
  await vendorsCard(mentorPage).getByRole('button', { name: 'Remove', exact: true }).nth(index).click();

  await expect.poll(() => vendorNames(mentorPage)).not.toContain(name);
});
