import { test, expect } from '../support/fixtures.js';
import { createMember } from '../support/api.js';
import { openTab, rowFor, expectToast } from '../support/ui.js';

// Each test makes its own member, so the shared role logins are never changed.
async function openTeam(page) {
  await openTab(page, 'Settings');
  await expect(page.getByRole('heading', { name: 'Team members', exact: true })).toBeVisible();
}

test('an admin promotes a student to mentor, and the change takes effect at their next sign-in', async ({ adminPage, anonPage, apiAs }) => {
  const member = await createMember(await apiAs('admin'), { role: 'student' });

  await openTeam(adminPage);
  await rowFor(adminPage, member.display_name).getByRole('combobox', { name: 'Role' }).selectOption('mentor');
  await expectToast(adminPage, 'Role updated');

  await anonPage.goto('/');
  await anonPage.getByLabel('Username', { exact: true }).fill(member.username);
  await anonPage.getByLabel('Password', { exact: true }).fill(member.password);
  await anonPage.getByRole('button', { name: 'Sign in' }).click();
  await anonPage.getByRole('navigation').getByRole('button', { name: /^Settings/ }).click();
  await expect(anonPage.getByRole('heading', { name: 'Team members', exact: true })).toBeVisible();
});

test('an admin disables and re-enables a member', async ({ adminPage, apiAs }) => {
  const member = await createMember(await apiAs('admin'));

  await openTeam(adminPage);
  await rowFor(adminPage, member.display_name).getByRole('button', { name: 'Disable', exact: true }).click();
  await expectToast(adminPage, 'Disabled');
  await expect(rowFor(adminPage, member.display_name).getByRole('button', { name: 'Enable', exact: true })).toBeVisible();

  await rowFor(adminPage, member.display_name).getByRole('button', { name: 'Enable', exact: true }).click();
  await expectToast(adminPage, 'Re-enabled');
});

test('an admin sets a temporary password, and the member signs in with it', async ({ adminPage, anonPage, apiAs }) => {
  const member = await createMember(await apiAs('admin'));
  const temporary = 'temp-reset-123';

  await openTeam(adminPage);
  await rowFor(adminPage, member.display_name).getByRole('button', { name: 'Reset password', exact: true }).click();
  await adminPage.getByRole('dialog').getByLabel('Temporary password', { exact: true }).fill(temporary);
  await adminPage.getByRole('dialog').getByRole('button', { name: 'Set password', exact: true }).click();
  await expectToast(adminPage, 'Password reset');

  await anonPage.goto('/');
  await anonPage.getByLabel('Username', { exact: true }).fill(member.username);
  await anonPage.getByLabel('Password', { exact: true }).fill(temporary);
  await anonPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(anonPage.getByRole('banner').getByText(member.display_name)).toBeVisible();
});

test('an admin deletes a member after confirming, and the row goes', async ({ adminPage, apiAs }) => {
  const member = await createMember(await apiAs('admin'));

  await openTeam(adminPage);
  adminPage.once('dialog', (dialog) => dialog.accept());
  await rowFor(adminPage, member.display_name).getByRole('button', { name: 'Delete', exact: true }).click();

  await expectToast(adminPage, 'Account deleted');
  await expect(rowFor(adminPage, member.display_name)).toHaveCount(0);
});
