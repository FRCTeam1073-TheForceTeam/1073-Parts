import { test, expect, uniq } from '../support/fixtures.js';
import { openTab, rowFor, expectToast } from '../support/ui.js';

test('a mentor gives a mechanism a budget, and the budget shows on the Budget tab', async ({ mentorPage, apiAs }) => {
  const name = uniq('E2E Mechanism');
  await (await apiAs('mentor')).post('/api/mechanisms', { data: { name } });

  await openTab(mentorPage, 'Budget');
  await rowFor(mentorPage, name).getByRole('button', { name: 'Set', exact: true }).click();
  await mentorPage.getByRole('dialog', { name: `${name} budget` }).getByLabel(/Budget \(\$\)/).fill('250');
  await mentorPage.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();

  await expectToast(mentorPage, 'Saved');
  await expect(rowFor(mentorPage, name)).toContainText('$250.00');
});
