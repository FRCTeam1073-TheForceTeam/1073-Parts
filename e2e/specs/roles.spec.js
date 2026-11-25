import { test, expect } from '../support/fixtures.js';
import { createMember } from '../support/api.js';

// What each role can see on the Settings tab. Only the server's checks (below) make this safe;
// hiding a button is not a permission.
async function openSettings(page) {
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'My account', exact: true })).toBeVisible();
}

test.describe('Settings tab by role', () => {
  test('a student sees only their own account', async ({ studentPage }) => {
    await openSettings(studentPage);

    await expect(studentPage.getByRole('heading', { name: 'Team members', exact: true })).toHaveCount(0);
    await expect(studentPage.getByRole('heading', { name: 'Approval', exact: true })).toHaveCount(0);
    await expect(studentPage.getByRole('heading', { name: 'Backup', exact: true })).toHaveCount(0);
  });

  test('a mentor sees the team list but not backups or the add-member button', async ({ mentorPage }) => {
    await openSettings(mentorPage);

    await expect(mentorPage.getByRole('heading', { name: 'Team members', exact: true })).toBeVisible();
    await expect(mentorPage.getByRole('button', { name: '+ Add member' })).toHaveCount(0);
    await expect(mentorPage.getByRole('heading', { name: 'Backup', exact: true })).toHaveCount(0);
  });

  test('an admin sees the add-member button and backups', async ({ adminPage }) => {
    await openSettings(adminPage);

    await expect(adminPage.getByRole('button', { name: '+ Add member' })).toBeVisible();
    await expect(adminPage.getByRole('heading', { name: 'Backup', exact: true })).toBeVisible();
  });
});

// The server refuses these calls whatever the page shows. Checking them directly catches a missing check.
test.describe('server refuses actions above a role', () => {
  test('a mentor cannot create an account (403)', async ({ apiAs }) => {
    const mentor = await apiAs('mentor');
    const res = await mentor.post('/api/users', { data: { username: 'x', display_name: 'x', password: 'long-enough', role: 'student' } });

    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe('Only admins can do that.');
  });

  test('a student cannot create an account (403)', async ({ apiAs }) => {
    const student = await apiAs('student');
    const res = await student.post('/api/users', { data: { username: 'x', display_name: 'x', password: 'long-enough', role: 'student' } });

    expect(res.status()).toBe(403);
  });

  test('a student cannot list the team (403), a mentor can (200)', async ({ apiAs }) => {
    expect((await (await apiAs('student')).get('/api/users')).status()).toBe(403);
    expect((await (await apiAs('mentor')).get('/api/users')).status()).toBe(200);
  });

  test('a student cannot change settings (403)', async ({ apiAs }) => {
    expect((await (await apiAs('student')).put('/api/settings', { data: {} })).status()).toBe(403);
  });

  test('only an admin can download a backup', async ({ apiAs }) => {
    expect((await (await apiAs('student')).get('/api/admin/backup')).status()).toBe(403);
    expect((await (await apiAs('mentor')).get('/api/admin/backup')).status()).toBe(403);
    expect((await (await apiAs('admin')).get('/api/admin/backup')).status()).toBe(200);
  });

  test('a signed-out request gets 401 on a mentor-only route', async ({ apiAs }) => {
    expect((await (await apiAs(null)).get('/api/users')).status()).toBe(401);
  });
});
