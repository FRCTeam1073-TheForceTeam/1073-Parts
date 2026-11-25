// HTTP route tests for accounts, settings, vendors, uploads, backups and the site shell.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/app-harness.js';
import { hashPassword } from '../../server/auth-core.js';

const admin = { id: 1, username: 'ava', display_name: 'Ava Admin', role: 'admin', password_hash: hashPassword('correct horse') };
const admin2 = { id: 2, username: 'bo', display_name: 'Bo Admin', role: 'admin', password_hash: 'x' };
const mentor = { id: 3, username: 'mo', display_name: 'Mo Mentor', role: 'mentor', password_hash: 'x' };
const student = { id: 4, username: 'sam', display_name: 'Sam Student', role: 'student', password_hash: 'x' };

describe('site shell', () => {
  let h;
  before(async () => {
    h = await startHarness({ storeOptions: { users: [admin, student] } });
  });
  after(() => h.close());

  it('answers the health check without a login', async () => {
    const res = await h.call('GET', '/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.text, 'ok');
  });

  it('sends the basic security headers', async () => {
    const res = await h.call('GET', '/healthz');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  it('reports that the team is already set up, and returns no user when signed out', async () => {
    const res = await h.call('GET', '/api/auth');
    assert.equal(res.json.setup, false);
    assert.equal(res.json.user, undefined);
  });

  it('returns a JSON 404 for unknown API paths when signed in', async () => {
    const res = await h.call('GET', '/api/does-not-exist', { user: student });
    assert.equal(res.status, 404);
    assert.deepEqual(res.json, { error: 'Not found' });
  });

  it('hides the public user record of a signed-in person without the password hash', async () => {
    const res = await h.call('GET', '/api/auth', { user: student });
    assert.equal(res.json.user.username, 'sam');
    assert.equal(res.json.user.password_hash, undefined);
  });
});

describe('first-run setup', () => {
  it('asks for the setup code when one is configured', async () => {
    const h = await startHarness({ setupCode: 'letmein' });
    try {
      const status = await h.call('GET', '/api/auth');
      assert.deepEqual([status.json.setup, status.json.setupNeedsCode], [true, true]);

      const wrong = await h.call('POST', '/api/setup', { body: { setup_code: 'nope', username: 'ava', display_name: 'Ava', password: 'long enough pw' } });
      assert.equal(wrong.status, 403);
      assert.equal(h.state.users.length, 0);

      const right = await h.call('POST', '/api/setup', { body: { setup_code: 'letmein', username: 'ava', display_name: 'Ava', password: 'long enough pw' } });
      assert.equal(right.status, 200);
      assert.equal(h.state.users[0].role, 'admin');
      assert.notEqual(h.state.users[0].password_hash, 'long enough pw', 'the password is stored hashed');
    } finally {
      await h.close();
    }
  });

  it('rejects a password that is too short and refuses to run twice', async () => {
    const h = await startHarness();
    try {
      const short = await h.call('POST', '/api/setup', { body: { username: 'ava', display_name: 'Ava', password: 'short' } });
      assert.equal(short.status, 400);
      assert.match(short.json.error, /at least 8 characters/);

      await h.call('POST', '/api/setup', { body: { username: 'ava', display_name: 'Ava', password: 'long enough pw' } });
      const again = await h.call('POST', '/api/setup', { body: { username: 'x', display_name: 'X', password: 'long enough pw' } });
      assert.equal(again.status, 400);
      assert.equal(again.json.error, 'Setup is already done.');
    } finally {
      await h.close();
    }
  });
});

describe('accounts', () => {
  let h;
  before(async () => {
    h = await startHarness({ storeOptions: { users: [admin, admin2, mentor, student] } });
  });
  after(() => h.close());

  it('lets only admins create accounts', async () => {
    const res = await h.call('POST', '/api/users', { user: mentor, body: { username: 'new', display_name: 'New', password: 'long enough pw' } });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'Only admins can do that.');
  });

  it('creates an account with a hashed password', async () => {
    const res = await h.call('POST', '/api/users', { user: admin, body: { username: ' rory ', display_name: 'Rory', password: 'long enough pw', role: 'mentor' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.role, 'mentor');
    assert.equal(res.json.password_hash, undefined);
    const stored = h.state.users.find((u) => u.username === 'rory');
    assert.ok(stored, 'username is trimmed and saved');
    assert.match(stored.password_hash, /^scrypt\$/);
  });

  it('refuses a duplicate username and an unknown role', async () => {
    const dup = await h.call('POST', '/api/users', { user: admin, body: { username: 'mo', display_name: 'Dup', password: 'long enough pw' } });
    assert.equal(dup.json.error, 'That username is taken.');
    const role = await h.call('POST', '/api/users', { user: admin, body: { username: 'zed', display_name: 'Zed', password: 'long enough pw', role: 'wizard' } });
    assert.equal(role.json.error, 'Bad role');
  });

  it('stops an admin deleting their own account', async () => {
    const res = await h.call('DELETE', '/api/users/1', { user: admin });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "You can't delete your own account.");
  });

  it('allows deleting another admin while one other admin remains', async () => {
    const res = await h.call('DELETE', '/api/users/2', { user: admin });
    assert.deepEqual(res.json, { ok: true });
  });

  it('stops the last admin being demoted', async () => {
    const res = await h.call('PATCH', '/api/users/1', { user: admin, body: { role: 'student' } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'The team needs at least one admin.');
  });

  it('returns 404 when changing an account that does not exist', async () => {
    const res = await h.call('PATCH', '/api/users/999', { user: admin, body: { display_name: 'x' } });
    assert.equal(res.status, 404);
  });

  it('checks the current password before changing your own password', async () => {
    const wrong = await h.call('PATCH', '/api/me', { user: admin, body: { current_password: 'nope', new_password: 'another long pw' } });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.error, 'Current password is wrong.');

    const right = await h.call('PATCH', '/api/me', { user: admin, body: { current_password: 'correct horse', new_password: 'another long pw' } });
    assert.equal(right.status, 200);
    assert.equal(right.json.user.username, 'ava');
  });

  it('lists the team to mentors but not to students', async () => {
    assert.equal((await h.call('GET', '/api/users', { user: mentor })).status, 200);
    assert.equal((await h.call('GET', '/api/users', { user: student })).status, 403);
  });
});

describe('settings, mechanisms and board columns', () => {
  let h;
  before(async () => {
    h = await startHarness({
      storeOptions: { users: [admin, mentor, student], columns: [{ id: 1, name: 'Todo' }] },
    });
  });
  after(() => h.close());

  it('lets a mentor save settings and a student not', async () => {
    const ok = await h.call('PUT', '/api/settings', { user: mentor, body: { require_approval: '1' } });
    assert.equal(ok.json.require_approval, '1');
    const denied = await h.call('PUT', '/api/settings', { user: student, body: { require_approval: '0' } });
    assert.equal(denied.status, 403);
  });

  it('requires a name for a new mechanism', async () => {
    const res = await h.call('POST', '/api/mechanisms', { user: mentor, body: { name: '   ' } });
    assert.equal(res.json.error, 'Name required');
  });

  it('will not delete the last board column', async () => {
    const res = await h.call('DELETE', '/api/board-columns/1', { user: mentor });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'The board needs at least one column.');
  });
});

describe('vendors', () => {
  let h;
  before(async () => {
    h = await startHarness({ storeOptions: { users: [mentor, student] } });
  });
  after(() => h.close());

  it('refuses a vendor name that is a built-in supplier, in any case', async () => {
    const res = await h.call('POST', '/api/vendors', { user: student, body: { name: 'wcp' } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'wcp is already a built-in supplier.');
  });

  it('lets a student add a new vendor with the next palette colour', async () => {
    const res = await h.call('POST', '/api/vendors', { user: student, body: { name: 'Acme Robotics' } });
    assert.equal(res.json.name, 'Acme Robotics');
    assert.equal(res.json.color, '#0ea5e9');
    assert.equal(res.json.website, null);
  });

  it('requires a vendor name', async () => {
    const res = await h.call('POST', '/api/vendors', { user: student, body: { name: '  ' } });
    assert.equal(res.json.error, 'Vendor name required');
  });
});

describe('Onshape keys', () => {
  it('clears the keys again when they do not work', async () => {
    const saved = [];
    const h = await startHarness({
      storeOptions: { users: [admin] },
      onshape: {
        saveKeys: (a, s) => saved.push([a, s]),
        testConnection: async () => { throw Object.assign(new Error('Onshape rejected the API keys. Check them under Settings → Onshape.'), { status: 400 }); },
        isConfigured: () => false,
        fetchParts: async () => [],
      },
    });
    try {
      const res = await h.call('PUT', '/api/onshape/keys', { user: admin, body: { access_key: 'a', secret_key: 's' } });
      assert.equal(res.status, 400);
      assert.match(res.json.error, /rejected the API keys/);
      assert.deepEqual(saved, [['a', 's'], ['', '']]);
    } finally {
      await h.close();
    }
  });

  it('requires both keys', async () => {
    const h = await startHarness({ storeOptions: { users: [admin] } });
    try {
      const res = await h.call('PUT', '/api/onshape/keys', { user: admin, body: { access_key: 'a' } });
      assert.equal(res.json.error, 'Both keys are required.');
    } finally {
      await h.close();
    }
  });
});

describe('uploads and part files', () => {
  let h;
  before(async () => {
    h = await startHarness({ storeOptions: { users: [student] } });
  });
  after(() => h.close());

  it('stores a real PNG and serves it back to a signed-in person', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
    const up = await h.call('POST', '/api/uploads', { user: student, headers: { 'content-type': 'image/png' }, raw: png });
    assert.match(up.json.url, /^\/api\/uploads\/[0-9a-f]{32}\.png$/);
    const got = await h.call('GET', up.json.url, { user: student });
    assert.equal(got.status, 200);
    assert.match(got.headers.get('content-type'), /image\/png/);
  });

  it('rejects an upload that only claims to be an image', async () => {
    const fake = Buffer.from('this is definitely not a picture of anything');
    const res = await h.call('POST', '/api/uploads', { user: student, headers: { 'content-type': 'image/jpeg' }, raw: fake });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /Upload a JPEG, PNG, WebP or GIF/);
  });

  it('will not serve an upload with a name that does not look like one of ours', async () => {
    const res = await h.call('GET', '/api/uploads/..%2Fsecret.png', { user: student });
    assert.equal(res.status, 404);
  });

  it('accepts a part file with an allowed extension, in any case', async () => {
    const body = Buffer.from('ISO-10303-21;');
    const res = await h.call('POST', `/api/files?name=${encodeURIComponent('bracket.STEP')}`, { user: student, raw: body });
    assert.equal(res.status, 200);
    assert.equal(res.json.name, 'bracket.STEP');
    assert.equal(res.json.size, body.length);
  });

  it('rejects a part file with a disallowed extension', async () => {
    const res = await h.call('POST', `/api/files?name=${encodeURIComponent('virus.exe')}`, { user: student, raw: Buffer.from('MZ') });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /Attach a \.step/);
  });

  it('rejects an empty part file', async () => {
    const res = await h.call('POST', `/api/files?name=${encodeURIComponent('empty.stl')}`, { user: student, raw: Buffer.alloc(0) });
    assert.equal(res.json.error, 'That file is empty.');
  });
});

describe('backups', () => {
  it('lets only admins download a backup', async () => {
    const h = await startHarness({
      storeOptions: { users: [admin, mentor] },
      createBackup: function* () { yield Buffer.from('TARDATA'); },
    });
    try {
      const denied = await h.call('GET', '/api/admin/backup', { user: mentor });
      assert.equal(denied.status, 403);

      const ok = await h.call('GET', '/api/admin/backup', { user: admin });
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get('content-type'), 'application/x-tar');
      assert.match(ok.headers.get('content-disposition'), /parts-backup-\d{4}-\d{2}-\d{2}\.tar/);
      assert.equal(ok.text, 'TARDATA');
    } finally {
      await h.close();
    }
  });

  it('reports a failed backup as a 500 without leaking the error', async () => {
    const h = await startHarness({
      storeOptions: { users: [admin] },
      createBackup: function* () { throw new Error('disk on fire'); },
    });
    try {
      const res = await h.call('GET', '/api/admin/backup', { user: admin });
      assert.equal(res.status, 500);
      assert.deepEqual(res.json, { error: 'Backup failed' });
    } finally {
      await h.close();
    }
  });
});
