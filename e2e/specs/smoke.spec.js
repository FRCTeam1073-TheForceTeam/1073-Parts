import { test, expect } from '../support/fixtures.js';
import { ACCOUNTS } from '../support/accounts.js';

// The top bar is the <header> (role "banner") and the tabs are the <nav> (role "navigation").
// Scope lookups to them: the same names also appear in the page content.

// Signing out ends the server session for that cookie, so this test signs in through the form in its own
// context. It must never sign out a shared role page, or later tests in the run would be logged out.
test('admin can sign in with the username and password form', async ({ anonPage }) => {
  await anonPage.goto('/');
  await anonPage.getByLabel('Username', { exact: true }).fill(ACCOUNTS.admin.username);
  await anonPage.getByLabel('Password', { exact: true }).fill(ACCOUNTS.admin.password);
  await anonPage.getByRole('button', { name: 'Sign in' }).click();

  await expect(anonPage.getByRole('navigation').getByRole('button', { name: 'Board' })).toBeVisible();
  await expect(anonPage.getByRole('banner').getByText(ACCOUNTS.admin.display_name)).toBeVisible();
});

test('signing out returns to the sign-in form', async ({ anonPage }) => {
  await anonPage.goto('/');
  await anonPage.getByLabel('Username', { exact: true }).fill(ACCOUNTS.student.username);
  await anonPage.getByLabel('Password', { exact: true }).fill(ACCOUNTS.student.password);
  await anonPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(anonPage.getByRole('banner').getByText(ACCOUNTS.student.display_name)).toBeVisible();

  await anonPage.getByRole('button', { name: 'Sign out' }).click();
  await expect(anonPage.getByLabel('Username', { exact: true })).toBeVisible();
});
