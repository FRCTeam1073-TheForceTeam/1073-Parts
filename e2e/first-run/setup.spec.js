import { test, expect } from '../support/fixtures.js';

// These run in order on one fresh server. The first step is the only time the server has no accounts,
// so every test here depends on the one before it. The setup code is the one in playwright.first-run.config.js.
test.describe.configure({ mode: 'serial' });

const CODE = 'e2e-setup-code';

async function openSetup(page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Create the admin account' })).toBeVisible();
}

function fillSetup(page, { code, name = 'E2E Owner', username = 'e2e-owner', password = 'owner-pass-1', confirm = password }) {
  return (async () => {
    if (code !== undefined) await page.getByLabel('Setup code', { exact: true }).fill(code);
    await page.getByLabel('Your name', { exact: true }).fill(name);
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByLabel('Confirm password', { exact: true }).fill(confirm);
  })();
}

test('a new server asks for the setup code and the admin details', async ({ anonPage }) => {
  await openSetup(anonPage);

  await expect(anonPage.getByLabel('Setup code', { exact: true })).toBeVisible();
});

test('a wrong setup code is refused and no account is created', async ({ anonPage }) => {
  await openSetup(anonPage);
  await fillSetup(anonPage, { code: 'not-the-code' });
  await anonPage.getByRole('button', { name: 'Create account' }).click();

  await expect(anonPage.getByRole('alert')).toHaveText('Wrong setup code.');
  await expect(anonPage.getByRole('heading', { name: 'Create the admin account' })).toBeVisible();
});

test('mismatched passwords are refused on the form', async ({ anonPage }) => {
  await openSetup(anonPage);
  await fillSetup(anonPage, { code: CODE, confirm: 'something-else' });
  await anonPage.getByRole('button', { name: 'Create account' }).click();

  await expect(anonPage.getByRole('alert')).toHaveText('Passwords do not match.');
});

test('a password under 8 characters is refused', async ({ anonPage }) => {
  await openSetup(anonPage);
  await fillSetup(anonPage, { code: CODE, password: 'short', confirm: 'short' });
  await anonPage.getByRole('button', { name: 'Create account' }).click();

  await expect(anonPage.getByRole('alert')).toHaveText('Password must be at least 8 characters.');
});

test('the right code creates the admin, who is signed in', async ({ anonPage }) => {
  await openSetup(anonPage);
  await fillSetup(anonPage, { code: CODE });
  await anonPage.getByRole('button', { name: 'Create account' }).click();

  await expect(anonPage.getByRole('banner').getByText('E2E Owner')).toBeVisible();
  await expect(anonPage.getByRole('banner').getByText('Admin', { exact: true })).toBeVisible();
});

test('after setup, the sign-in form replaces the setup form', async ({ anonPage }) => {
  await anonPage.goto('/');

  await expect(anonPage.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(anonPage.getByRole('heading', { name: 'Create the admin account' })).toHaveCount(0);
});
