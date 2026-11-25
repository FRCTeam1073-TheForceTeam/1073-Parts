import { test, expect, uniq } from '../support/fixtures.js';
import { openTab, expectToast } from '../support/ui.js';

// A custom part made through the API, in the first stage of the board.
async function makePart(api, name) {
  const meta = await (await api.get('/api/meta')).json();
  const res = await api.post('/api/custom-parts', { data: { name, column_id: meta.columns[0].id, quantity: 1 } });
  expect(res.ok()).toBe(true);
  return { id: (await res.json()).id, columns: meta.columns };
}

test('a mentor moves a part to the next stage with the card\'s "Move to" button', async ({ mentorPage, apiAs }) => {
  const name = uniq('E2E Stage Card');
  const { columns } = await makePart(await apiAs('mentor'), name);

  await openTab(mentorPage, 'Board');
  const card = mentorPage.getByRole('article').filter({ hasText: name });
  await card.getByRole('button', { name: `Move to ${columns[1].name}`, exact: true }).click();

  await expect(mentorPage.getByRole('article').filter({ hasText: name }).getByRole('button', { name: `Move to ${columns[2].name}`, exact: true })).toBeVisible();
});

test('a mentor changes a part\'s stage from the list view', async ({ mentorPage, apiAs }) => {
  const name = uniq('E2E Stage List');
  const { columns } = await makePart(await apiAs('mentor'), name);

  await openTab(mentorPage, 'Board');
  await mentorPage.getByRole('button', { name: 'List', exact: true }).click();
  const row = mentorPage.getByRole('row').filter({ hasText: name });
  await row.getByRole('combobox', { name: 'Stage' }).selectOption({ label: columns[2].name });

  await expect(row.getByRole('combobox', { name: 'Stage' })).toHaveValue(String(columns[2].id));
});
