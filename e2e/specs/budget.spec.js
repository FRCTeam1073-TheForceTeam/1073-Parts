import { test, expect } from '../support/fixtures.js';
import { openTab, expectToast } from '../support/ui.js';

test('a student sees the season budget but cannot change it', async ({ studentPage }) => {
  await openTab(studentPage, 'Budget');

  await expect(studentPage.getByRole('main').getByRole('heading', { name: 'Season' })).toBeVisible();
  await expect(studentPage.getByRole('main').getByRole('button', { name: /season budget$/i })).toHaveCount(0);
});

test('a mentor sets the season budget and the page shows it', async ({ mentorPage }) => {
  await openTab(mentorPage, 'Budget');
  await mentorPage.getByRole('main').getByRole('button', { name: /season budget$/i }).click();
  await mentorPage.getByLabel('Total budget ($)', { exact: true }).fill('1000');
  await mentorPage.getByRole('button', { name: 'Save', exact: true }).click();

  await expectToast(mentorPage, 'Saved');
  // With no orders yet the page shows no meter. The season budget and "Left to spend" both read $1,000.00.
  await expect(mentorPage.getByRole('main').getByText('$1,000.00', { exact: true })).toHaveCount(2);
});
