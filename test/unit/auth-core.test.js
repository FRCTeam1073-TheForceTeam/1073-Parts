// Password hashing, role checks and login throttling (server/auth-core.js). No database.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword, verifyPassword, validatePassword, publicUser, isAtLeast, requireRole, requireUser,
  createLoginThrottle, ROLES,
} from '../../server/auth-core.js';

describe('passwords', () => {
  it('verifies the right password and rejects a wrong one', () => {
    const stored = hashPassword('correct horse battery');
    assert.equal(verifyPassword('correct horse battery', stored), true);
    assert.equal(verifyPassword('correct horse battery!', stored), false);
  });

  it('salts every hash, so the same password never gives the same stored value', () => {
    assert.notEqual(hashPassword('same password'), hashPassword('same password'));
  });

  it('stores scrypt$salt$hash', () => {
    assert.match(hashPassword('whatever'), /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  });

  it('rejects stored values that are not in the expected format', () => {
    assert.equal(verifyPassword('x', 'md5$abc$def'), false, 'other scheme');
    assert.equal(verifyPassword('x', 'scrypt$only-two'), false, 'missing hash');
    assert.equal(verifyPassword('x', ''), false, 'empty');
    assert.equal(verifyPassword('x', undefined), false, 'undefined');
  });

  it('rejects a stored hash of the wrong length instead of throwing', () => {
    const real = hashPassword('pw');
    const truncated = real.slice(0, real.length - 10);
    assert.equal(verifyPassword('pw', truncated), false);
  });

  it('requires at least 8 characters and a string', () => {
    assert.equal(validatePassword('1234567'), 'Password must be at least 8 characters.');
    assert.equal(validatePassword('12345678'), null);
    assert.equal(validatePassword(undefined), 'Password must be at least 8 characters.');
    assert.equal(validatePassword(12345678), 'Password must be at least 8 characters.');
  });
});

describe('publicUser', () => {
  it('keeps the public fields and drops the password hash', () => {
    const out = publicUser({ id: 4, username: 'sam', display_name: 'Sam', role: 'student', disabled: 0, created_at: 'd', password_hash: 'secret' });
    assert.deepEqual(out, { id: 4, username: 'sam', display_name: 'Sam', role: 'student', disabled: false, created_at: 'd' });
  });

  it('turns the disabled flag into a boolean', () => {
    assert.equal(publicUser({ id: 1, disabled: 1 }).disabled, true);
  });

  it('passes null through', () => {
    assert.equal(publicUser(null), null);
  });
});

describe('roles', () => {
  it('ranks student < mentor < admin', () => {
    assert.deepEqual(ROLES, ['student', 'mentor', 'admin']);
    assert.equal(isAtLeast({ role: 'admin' }, 'mentor'), true);
    assert.equal(isAtLeast({ role: 'mentor' }, 'mentor'), true);
    assert.equal(isAtLeast({ role: 'student' }, 'mentor'), false);
  });

  it('is false with no user at all', () => {
    assert.equal(isAtLeast(undefined, 'student'), false);
  });

  it('requireRole lets the right role through and answers 403 otherwise', () => {
    const mw = requireRole('admin');
    const calls = [];
    const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };

    mw({ user: { role: 'mentor' } }, res, () => calls.push('next'));
    assert.deepEqual(calls, []);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: 'Only admins can do that.' });

    mw({ user: { role: 'admin' } }, res, () => calls.push('next'));
    assert.deepEqual(calls, ['next']);
  });

  it('requireUser answers 401 when nobody is signed in', () => {
    const res = { statusCode: 0, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let called = false;
    requireUser({}, res, () => { called = true; });
    assert.equal(called, false);
    assert.equal(res.statusCode, 401);
    requireUser({ user: { id: 1 } }, res, () => { called = true; });
    assert.equal(called, true);
  });
});

describe('login throttle', () => {
  const makeClock = (start = 0) => {
    let now = start;
    return { now: () => now, advance: (ms) => { now += ms; } };
  };
  const minutes = (m) => m * 60 * 1000;

  it('allows nine failures and blocks the tenth attempt', () => {
    const t = createLoginThrottle({ now: makeClock().now });
    for (let i = 0; i < 9; i++) {
      assert.equal(t.throttled('ip:sam'), false);
      t.recordFailure('ip:sam');
    }
    assert.equal(t.throttled('ip:sam'), false);
    t.recordFailure('ip:sam');
    assert.equal(t.throttled('ip:sam'), true);
  });

  it('keeps each key separate', () => {
    const t = createLoginThrottle({ now: makeClock().now });
    for (let i = 0; i < 10; i++) t.recordFailure('ip:sam');
    assert.equal(t.throttled('ip:sam'), true);
    assert.equal(t.throttled('ip:pat'), false);
  });

  it('forgets failures after 15 minutes', () => {
    const clock = makeClock();
    const t = createLoginThrottle({ now: clock.now });
    for (let i = 0; i < 10; i++) t.recordFailure('k');
    assert.equal(t.throttled('k'), true);
    clock.advance(minutes(15));
    assert.equal(t.throttled('k'), false);
  });

  it('only forgets the oldest failures as the window slides', () => {
    const clock = makeClock();
    const t = createLoginThrottle({ now: clock.now, limit: 2 });
    t.recordFailure('k');
    clock.advance(minutes(10));
    t.recordFailure('k');
    clock.advance(minutes(6)); // first failure is now 16 minutes old
    assert.equal(t.throttled('k'), false);
  });

  it('clears a key after a successful login', () => {
    const t = createLoginThrottle({ now: makeClock().now });
    for (let i = 0; i < 10; i++) t.recordFailure('k');
    t.clear('k');
    assert.equal(t.throttled('k'), false);
  });
});
