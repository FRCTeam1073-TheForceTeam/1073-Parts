import { test, expect, uniq } from '../support/fixtures.js';
import { setSettings, readSettings } from '../support/api.js';
import { openTab, expectToast } from '../support/ui.js';
import { authPath } from '../support/accounts.js';

// Settings that change how the whole team works. Each test puts back what it changed.

test('a mentor turns on approval with a threshold, and a student sees the approval notice', async ({ mentorPage, studentPage, playwright, baseURL }) => {
  const admin = await playwright.request.newContext({ baseURL, storageState: authPath('admin') });
  const before = await readSettings(admin, ['require_approval', 'approval_threshold_cents']);
  try {
    await openTab(mentorPage, 'Settings');
    await mentorPage.getByRole('checkbox', { name: /Student requests need a mentor/ }).check();
    await mentorPage.getByLabel(/unless the line total is at or under/).fill('20');
    await mentorPage.getByRole('button', { name: 'Save', exact: true }).last().click();
    await expectToast(mentorPage, 'Saved');

    await openTab(studentPage, 'Orders');
    await studentPage.getByRole('button', { name: '+ Add part', exact: true }).click();
    await studentPage.getByLabel('Unit price ($)', { exact: true }).fill('50');
    await studentPage.getByLabel('Quantity needed', { exact: true }).fill('1');
    await expect(studentPage.getByRole('button', { name: 'Submit for approval', exact: true })).toBeVisible();
  } finally {
    await setSettings(admin, before);
    await admin.dispose();
  }
});

// Mechanism names in order. The name inputs have no attribute holding the value, so read them from the page.
const mechanismNames = (page) => page.getByRole('textbox', { name: 'Name', exact: true }).evaluateAll((els) => els.map((e) => e.value));
const mechanismsCard = (page) => page.locator('.card', { has: page.getByRole('heading', { name: 'Mechanisms', exact: true }) });

test('a mentor renames a mechanism and it keeps the new name', async ({ mentorPage, apiAs }) => {
  const original = uniq('E2E Mech Original');
  const renamed = uniq('E2E Mech Renamed');
  await (await apiAs('mentor')).post('/api/mechanisms', { data: { name: original } });

  await openTab(mentorPage, 'Settings');
  const index = (await mechanismNames(mentorPage)).indexOf(original);
  const input = mentorPage.getByRole('textbox', { name: 'Name', exact: true }).nth(index);
  await input.fill(renamed);
  await input.press('Tab');

  await expect.poll(() => mechanismNames(mentorPage)).toContain(renamed);
});

test('a mentor removes a mechanism after confirming', async ({ mentorPage, apiAs }) => {
  const name = uniq('E2E Mech Remove');
  await (await apiAs('mentor')).post('/api/mechanisms', { data: { name } });

  await openTab(mentorPage, 'Settings');
  const index = (await mechanismNames(mentorPage)).indexOf(name);
  mentorPage.once('dialog', (dialog) => dialog.accept());
  await mechanismsCard(mentorPage).getByRole('button', { name: 'Remove', exact: true }).nth(index).click();

  await expect.poll(() => mechanismNames(mentorPage)).not.toContain(name);
});

test('a mentor adds a board stage and then removes it', async ({ mentorPage }) => {
  const stage = uniq('E2E Stage');

  await openTab(mentorPage, 'Settings');
  const card = mentorPage.locator('.card', { has: mentorPage.getByRole('heading', { name: 'Manufacturing board', exact: true }) });
  await card.getByPlaceholder('New stage (e.g. Powder coat)').fill(stage);
  await card.getByRole('button', { name: 'Add', exact: true }).click();

  const stageNames = () => mentorPage.getByRole('textbox', { name: 'Stage name', exact: true }).evaluateAll((els) => els.map((e) => e.value));
  await expect.poll(stageNames).toContain(stage);

  const index = (await stageNames()).indexOf(stage);
  mentorPage.once('dialog', (dialog) => dialog.accept());
  await card.getByRole('button', { name: 'Remove', exact: true }).nth(index).click();

  await expect.poll(stageNames).not.toContain(stage);
});
