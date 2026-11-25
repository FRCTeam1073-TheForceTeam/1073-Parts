// Runs createApp() with a fake store on a random local port. No database is opened.
// The real account rules (roles, password hashing) come from auth-core.js. Only the cookie/session
// layer is replaced: a request names its user with the `x-test-user` header.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as authCore from '../../../server/auth-core.js';
import * as suppliers from '../../../server/suppliers.js';
import { createApp } from '../../../server/app.js';
import { makeFakeStore } from './fake-store.js';

export async function startHarness({ storeOptions = {}, setupCode = '', onshape = null, createBackup } = {}) {
  const fake = makeFakeStore(storeOptions);
  const { store } = fake;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parts-unit-'));

  const auth = {
    ...authCore,
    loadUser(req, res, next) {
      const id = req.headers['x-test-user'];
      if (id) req.user = store.getUser(Number(id)) ?? undefined;
      next();
    },
    userCount: () => store.countUsers(),
    startSession(res, userId) {
      res.setHeader('Set-Cookie', `pt_session=fake-${userId}`);
    },
    endSession() {},
    endAllSessions() {},
    loginThrottled: () => false,
    recordFailedLogin() {},
    clearFailedLogins() {},
  };

  const built = createApp({
    store,
    auth,
    suppliers,
    onshape: onshape || {
      isConfigured: () => false,
      saveKeys() {},
      testConnection: async () => ({ name: 'test' }),
      fetchParts: async () => [],
    },
    createBackup: createBackup || (function* () { throw new Error('this test has no backup'); }),
    dataDir,
    setupCode,
  });

  const server = await new Promise((resolve) => {
    const s = built.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  // Quiet the console.error the error handler prints for 500s.
  const originalError = console.error;
  console.error = () => {};

  async function call(method, url, { user, body, headers = {}, raw } = {}) {
    const init = { method, headers: { ...headers } };
    if (user) init.headers['x-test-user'] = String(user.id ?? user);
    if (raw !== undefined) {
      init.body = raw;
    } else if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(base + url, { ...init, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON (CSV, HTML, ...)
    }
    return { status: res.status, headers: res.headers, text, json };
  }

  return {
    store,
    state: fake.state,
    call,
    built,
    dataDir,
    async close() {
      console.error = originalError;
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
