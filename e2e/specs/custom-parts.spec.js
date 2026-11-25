import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, uniq } from '../support/fixtures.js';
import { openTab, expectToast } from '../support/ui.js';

const FIXTURES = fileURLToPath(new URL('../fixtures-files/', import.meta.url));
const cardFor = (page, name) => page.getByRole('article').filter({ hasText: name });

test('a mentor records how many parts are made, and the card shows the progress', async ({ mentorPage }) => {
  const name = uniq('E2E Progress');

  await openTab(mentorPage, 'Board');
  await mentorPage.getByRole('button', { name: '+ Custom part', exact: true }).click();
  await mentorPage.getByLabel('Part name', { exact: true }).fill(name);
  await mentorPage.getByLabel('Quantity needed', { exact: true }).fill('5');
  await mentorPage.getByRole('button', { name: 'Add part', exact: true }).click();
  await expectToast(mentorPage, 'Custom part added');

  await cardFor(mentorPage, name).click();
  await mentorPage.getByRole('dialog').getByLabel('Quantity made', { exact: true }).fill('2');
  await mentorPage.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();

  await expect(cardFor(mentorPage, name)).toContainText('2/5');
});

test('a CAD file attached to a custom part is kept with it', async ({ mentorPage }) => {
  const name = uniq('E2E Attach');

  await openTab(mentorPage, 'Board');
  await mentorPage.getByRole('button', { name: '+ Custom part', exact: true }).click();
  await mentorPage.getByLabel('Part name', { exact: true }).fill(name);
  const chooser = mentorPage.waitForEvent('filechooser');
  // The button sits inside a <label>, so its accessible name is the label text. Find it by its visible text.
  await mentorPage.getByText('+ Attach file', { exact: true }).click();
  (await chooser).setFiles(path.join(FIXTURES, 'bracket.dxf'));
  await expect(mentorPage.getByRole('dialog').getByText('bracket.dxf', { exact: true })).toBeVisible();
  await mentorPage.getByRole('button', { name: 'Add part', exact: true }).click();
  await expectToast(mentorPage, 'Custom part added');

  await cardFor(mentorPage, name).click();
  await expect(mentorPage.getByRole('dialog').getByRole('link', { name: 'bracket.dxf', exact: true })).toBeVisible();
});

test('a mentor deletes a custom part after confirming', async ({ mentorPage, apiAs }) => {
  const name = uniq('E2E Delete Part');
  const api = await apiAs('mentor');
  const meta = await (await api.get('/api/meta')).json();
  const made = await api.post('/api/custom-parts', { data: { name, column_id: meta.columns[0].id, quantity: 1 } });
  expect(made.ok()).toBe(true);

  await openTab(mentorPage, 'Board');
  await expect(cardFor(mentorPage, name)).toBeVisible();
  await cardFor(mentorPage, name).click();
  mentorPage.once('dialog', (dialog) => dialog.accept());
  await mentorPage.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();

  await expect(cardFor(mentorPage, name)).toHaveCount(0);
});
