// Runs once before the specs. The server is new and empty, so this creates the admin through the
// first-run API, adds a mentor and a student through the admin's API, and saves a login state for each role.
// Setup goes through the HTTP API, not SQL, so the database layer stays the only code that writes SQL.
import fs from 'node:fs';
import { request } from '@playwright/test';
import { ACCOUNTS, authPath } from './accounts.js';

async function expectOk(response, what) {
  if (!response.ok()) {
    throw new Error(`${what} failed: HTTP ${response.status()} ${await response.text()}`);
  }
}

export default async function globalSetup(config) {
  const baseURL = config.projects[0].use.baseURL;
  fs.mkdirSync(new URL('../.auth/', import.meta.url), { recursive: true });

  const admin = await request.newContext({ baseURL });
  const { username, display_name, password } = ACCOUNTS.admin;
  await expectOk(await admin.post('/api/setup', { data: { username, display_name, password } }), 'first-run setup');
  await admin.storageState({ path: authPath('admin') });

  for (const role of ['mentor', 'student']) {
    const account = ACCOUNTS[role];
    await expectOk(await admin.post('/api/users', { data: account }), `create ${role}`);
  }
  await admin.dispose();

  for (const role of ['mentor', 'student']) {
    const ctx = await request.newContext({ baseURL });
    const { username: user, password: pw } = ACCOUNTS[role];
    await expectOk(await ctx.post('/api/login', { data: { username: user, password: pw } }), `log in as ${role}`);
    await ctx.storageState({ path: authPath(role) });
    await ctx.dispose();
  }
}
