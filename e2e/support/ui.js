// Small page helpers shared by the workflow specs. They only find things the way a user would.
import { expect } from '@playwright/test';

// Nav buttons can carry a badge (e.g. "Orders1"), so match the start of the label.
export async function openTab(page, name) {
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: new RegExp(`^${name}`) }).click();
}

// Playwright has no getByDisplayValue for this, so read the values and check them.
export async function expectInputValue(locator, value) {
  await expect.poll(() => locator.evaluateAll((els) => els.map((e) => e.value))).toContain(value);
}

// The row for a part, found by its visible name.
export const rowFor = (page, name) => page.getByRole('row').filter({ hasText: name });

// Orders page filter tabs. Their labels can include a count, e.g. "Pending Approval (2)".
export async function pickOrdersTab(page, label) {
  await page.getByRole('button', { name: new RegExp(`^${label}`) }).click();
}

// Opens "Add part" (or "+ Add to inventory") form pieces by label, then submits.
export async function fillPartForm(page, { name, supplierName, quantity, price }) {
  await page.getByLabel('Part name', { exact: true }).fill(name);
  if (supplierName) await page.getByLabel('Supplier', { exact: true }).selectOption({ label: supplierName });
  if (quantity != null) await page.getByLabel(/^Quantity (needed|on hand)$/).fill(String(quantity));
  if (price != null) await page.getByLabel('Unit price ($)', { exact: true }).fill(String(price));
}

export async function expectToast(page, text) {
  await expect(page.locator('#toast')).toContainText(text);
}
