import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './helpers/db.js';
import { makeUser, makeOrder } from './helpers/fixtures.js';

let t;
before(async () => { t = await openTestDb(); });
after(() => t.close());
beforeEach(() => t.reset());

test('createUser stores the account and getUser returns it', () => {
  const u = t.data.createUser({ username: 'Ada', display_name: 'Ada L', password_hash: 'h', role: 'mentor' });
  assert.equal(u.username, 'Ada');
  assert.equal(u.role, 'mentor');
  assert.equal(u.disabled, 0);
  assert.equal(t.data.getUser(u.id).display_name, 'Ada L');
  assert.equal(t.data.getUser(999999), undefined);
});

test('usernames are unique and ignore case', () => {
  t.data.createUser({ username: 'Ada', display_name: 'A', password_hash: 'h', role: 'student' });
  assert.equal(t.data.findUserByUsername('ADA').username, 'Ada');
  assert.equal(t.data.findUserByUsername('nobody'), undefined);
  assert.throws(() => t.data.createUser({ username: 'ada', display_name: 'B', password_hash: 'h', role: 'student' }), /UNIQUE/);
});

test('listUsers sorts by role text, then name ignoring case', () => {
  // Role order is alphabetical text (student, mentor, admin), as the team list has always been sorted.
  makeUser(t.data, { display_name: 'zed', role: 'student' });
  makeUser(t.data, { display_name: 'Amy', role: 'student' });
  makeUser(t.data, { display_name: 'Bo', role: 'mentor' });
  makeUser(t.data, { display_name: 'Cy', role: 'admin' });
  assert.deepEqual(t.data.listUsers().map((u) => u.display_name), ['Amy', 'zed', 'Bo', 'Cy']);
});

test('updateUser changes only the given fields', () => {
  const u = makeUser(t.data);
  t.data.updateUser(u.id, { display_name: 'New Name', role: 'mentor', disabled: 1 });
  const updated = t.data.getUser(u.id);
  assert.equal(updated.display_name, 'New Name');
  assert.equal(updated.role, 'mentor');
  assert.equal(updated.disabled, 1);
  assert.equal(updated.username, u.username);
});

test('updateUser with no fields returns the row unchanged', () => {
  const u = makeUser(t.data);
  assert.deepEqual(t.data.updateUser(u.id, {}), u);
});

test('deleting a user keeps their orders (created_by cleared) and removes their sessions', () => {
  const u = makeUser(t.data);
  const o = makeOrder(t.data, { created_by: u.id });
  t.data.createSession('token-hash-1', u.id, 30);
  t.data.deleteUser(u.id);
  assert.equal(t.data.getUser(u.id), undefined);
  assert.equal(t.data.getOrder(o.id).created_by, null);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('countActiveAdmins ignores disabled admins and the excluded id', () => {
  const a1 = makeUser(t.data, { role: 'admin' });
  makeUser(t.data, { role: 'admin' });
  makeUser(t.data, { role: 'admin', disabled: 1 });
  assert.equal(t.data.countActiveAdmins(a1.id), 1);
  assert.equal(t.data.countActiveAdmins(999999), 2);
});

test('listTeam lists only active accounts, by name', () => {
  makeUser(t.data, { display_name: 'bea' });
  makeUser(t.data, { display_name: 'Al' });
  makeUser(t.data, { display_name: 'Gone', disabled: 1 });
  assert.deepEqual(t.data.listTeam().map((u) => u.display_name), ['Al', 'bea']);
});
