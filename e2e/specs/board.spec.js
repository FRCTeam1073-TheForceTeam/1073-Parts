import { test, expect, uniq } from '../support/fixtures.js';
import { openTab, expectToast } from '../support/ui.js';

test('a mentor adds a custom part to the manufacturing board', async ({ mentorPage }) => {
  const name = uniq('E2E Cam Follower');

  await openTab(mentorPage, 'Board');
  await mentorPage.getByRole('button', { name: '+ Custom part', exact: true }).click();
  await mentorPage.getByLabel('Part name', { exact: true }).fill(name);
  await mentorPage.getByRole('button', { name: 'Add part', exact: true }).click();

  await expectToast(mentorPage, 'Custom part added');
  await expect(mentorPage.getByText(name, { exact: true })).toBeVisible();
});
