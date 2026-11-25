import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './helpers/db.js';
import { makeUser } from './helpers/fixtures.js';

let t;
before(async () => { t = await openTestDb(); });
after(() => t.close());
beforeEach(() => t.reset());

test('a stored session finds its user', () => {
  const u = makeUser(t.data);
  t.data.createSession('hash-a', u.id, 180);
  assert.equal(t.data.findUserBySession('hash-a').id, u.id);
  assert.equal(t.data.findUserBySession('unknown-hash'), undefined);
});

test('a session expires after its lifetime', () => {
  const u = makeUser(t.data);
  t.data.createSession('hash-b', u.id, 180);
  const days = t.db.prepare("SELECT julianday(expires_at) - julianday('now') AS d FROM sessions WHERE token_hash = 'hash-b'").get().d;
  assert.ok(Math.abs(days - 180) < 0.01, `expected about 180 days, got ${days}`);
  t.db.prepare("UPDATE sessions SET expires_at = datetime('now', '-1 day') WHERE token_hash = 'hash-b'").run();
  assert.equal(t.data.findUserBySession('hash-b'), undefined);
});

test('a disabled user cannot use an existing session', () => {
  const u = makeUser(t.data);
  t.data.createSession('hash-c', u.id, 180);
  t.data.updateUser(u.id, { disabled: 1 });
  assert.equal(t.data.findUserBySession('hash-c'), undefined);
});

test('deleteSession removes one session only', () => {
  const u = makeUser(t.data);
  t.data.createSession('hash-d', u.id, 180);
  t.data.createSession('hash-e', u.id, 180);
  t.data.deleteSession('hash-d');
  assert.equal(t.data.findUserBySession('hash-d'), undefined);
  assert.equal(t.data.findUserBySession('hash-e').id, u.id);
});

test('deleteUserSessions removes every session for that user and no others', () => {
  const u = makeUser(t.data);
  const other = makeUser(t.data);
  t.data.createSession('hash-f', u.id, 180);
  t.data.createSession('hash-g', u.id, 180);
  t.data.createSession('hash-h', other.id, 180);
  t.data.deleteUserSessions(u.id);
  assert.equal(t.data.findUserBySession('hash-f'), undefined);
  assert.equal(t.data.findUserBySession('hash-g'), undefined);
  assert.equal(t.data.findUserBySession('hash-h').id, other.id);
});
