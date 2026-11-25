import { test, expect, uniq } from '../support/fixtures.js';
import { ACCOUNTS } from '../support/accounts.js';
import { createMember } from '../support/api.js';

const WRONG = 'Wrong username or password.';

async function signIn(page, username, password) {
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('a wrong password shows an error and keeps the sign-in form', async ({ anonPage }) => {
  await signIn(anonPage, ACCOUNTS.admin.username, 'not-the-password');

  await expect(anonPage.getByRole('alert')).toHaveText(WRONG);
  await expect(anonPage.getByLabel('Username', { exact: true })).toBeVisible();
});

test('an unknown username gets the same error as a wrong password', async ({ anonPage }) => {
  await signIn(anonPage, uniq('e2e-nobody'), 'whatever-password');

  await expect(anonPage.getByRole('alert')).toHaveText(WRONG);
});

test('a disabled account cannot sign in, and gets the same error as a wrong password', async ({ anonPage, apiAs }) => {
  const member = await createMember(await apiAs('admin'));
  const admin = await apiAs('admin');
  const res = await admin.patch(`/api/users/${member.id}`, { data: { disabled: true } });
  expect(res.ok()).toBe(true);

  await signIn(anonPage, member.username, member.password);

  await expect(anonPage.getByRole('alert')).toHaveText(WRONG);
});

test('a member can change their password and then sign in with the new one', async ({ anonPage, apiAs }) => {
  const member = await createMember(await apiAs('admin'));
  const newPassword = 'e2e-new-pass-123';

  await signIn(anonPage, member.username, member.password);
  await anonPage.getByRole('navigation').getByRole('button', { name: 'Settings' }).click();
  await anonPage.getByLabel('Current password', { exact: true }).fill(member.password);
  await anonPage.getByLabel('New password', { exact: true }).fill(newPassword);
  await anonPage.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(anonPage.getByText('Password changed')).toBeVisible();

  await anonPage.getByRole('button', { name: 'Sign out' }).click();
  await signIn(anonPage, member.username, newPassword);
  await expect(anonPage.getByRole('banner').getByText(member.display_name)).toBeVisible();
});
