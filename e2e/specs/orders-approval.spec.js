import { test, expect, uniq } from '../support/fixtures.js';
import { createVendor, createRequest, setSettings } from '../support/api.js';
import { openTab, rowFor, pickOrdersTab, expectToast } from '../support/ui.js';
import { authPath } from '../support/accounts.js';

// Turns approval on for this file only. Tests in this file run one at a time, and the setting is put back
// in afterAll, so other specs still see the default (approval off).
test.describe.configure({ mode: 'serial' });

let previous;
test.beforeAll(async ({ playwright, baseURL }) => {
  const admin = await playwright.request.newContext({ baseURL, storageState: authPath('admin') });
  previous = await setSettings(admin, { require_approval: '1', approval_threshold_cents: '0' });
  await admin.dispose();
});
test.afterAll(async ({ playwright, baseURL }) => {
  const admin = await playwright.request.newContext({ baseURL, storageState: authPath('admin') });
  await setSettings(admin, previous);
  await admin.dispose();
});

test('a student request waits for approval, and a mentor can approve it', async ({ studentPage, mentorPage, apiAs }) => {
  const vendor = await createVendor(await apiAs('mentor'));
  const name = uniq('E2E Gusset');
  await createRequest(await apiAs('student'), { name, supplier: vendor, quantity: 2, unit_price_cents: 500 });

  await openTab(studentPage, 'Orders');
  await pickOrdersTab(studentPage, 'Pending Approval');
  await expect(rowFor(studentPage, name).getByText('Awaiting approval', { exact: true })).toBeVisible();

  await openTab(mentorPage, 'Orders');
  await pickOrdersTab(mentorPage, 'Pending Approval');
  await rowFor(mentorPage, name).getByRole('button', { name: /Approve$/ }).click();

  await expectToast(mentorPage, 'Approved 1 request');
  await expect(rowFor(mentorPage, name).getByRole('button', { name: /Approve$/ })).toHaveCount(0);
});

test('a mentor rejects a request with a reason, and the student sees the reason', async ({ studentPage, mentorPage, apiAs }) => {
  const vendor = await createVendor(await apiAs('mentor'));
  const name = uniq('E2E Plate');
  const reason = 'We have these in the spares bin';
  await createRequest(await apiAs('student'), { name, supplier: vendor, quantity: 1, unit_price_cents: 900 });

  await openTab(mentorPage, 'Orders');
  await pickOrdersTab(mentorPage, 'Pending Approval');
  await rowFor(mentorPage, name).getByRole('button', { name: /Reject$/ }).click();
  await mentorPage.getByLabel('Reason (shown to the requester)', { exact: true }).fill(reason);
  await mentorPage.getByRole('button', { name: 'Reject', exact: true }).click();
  await expectToast(mentorPage, 'Request rejected');

  await openTab(studentPage, 'Orders');
  await pickOrdersTab(studentPage, 'Mine');
  await expect(rowFor(studentPage, name)).toContainText(`Rejected by E2E Mentor: ${reason}`);
});

test('a student cannot approve a request, even by calling the API (403)', async ({ apiAs }) => {
  const vendor = await createVendor(await apiAs('mentor'));
  const order = await createRequest(await apiAs('student'), { name: uniq('E2E Sneaky'), supplier: vendor, unit_price_cents: 500 });

  const res = await (await apiAs('student')).post(`/api/orders/${order.id}/approve`);
  expect(res.status()).toBe(403);
});
