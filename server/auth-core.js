// Pure account helpers: password hashing, role checks, and login throttling.
// Nothing here touches the database, so it can be unit tested directly.
import crypto from 'node:crypto';

export const ROLES = ['student', 'mentor', 'admin'];

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const given = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === given.length && crypto.timingSafeEqual(given, expected);
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters.';
  return null;
}

export function publicUser(u) {
  return u && { id: u.id, username: u.username, display_name: u.display_name, role: u.role, disabled: !!u.disabled, created_at: u.created_at };
}

const rank = (role) => ROLES.indexOf(role);

export function isAtLeast(user, role) {
  return !!user && rank(user.role) >= rank(role);
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!isAtLeast(req.user, role)) return res.status(403).json({ error: `Only ${role}s can do that.` });
    next();
  };
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  next();
}

// Sliding-window limiter for failed logins, keyed by e.g. "ip:username".
// `now` is injectable so tests can move the clock.
export function createLoginThrottle({ limit = 10, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
  const attempts = new Map();
  const recent = (key) => (attempts.get(key) || []).filter((t) => now() - t < windowMs);
  return {
    throttled(key) {
      const list = recent(key);
      attempts.set(key, list);
      return list.length >= limit;
    },
    recordFailure(key) {
      attempts.set(key, [...recent(key), now()]);
    },
    clear(key) {
      attempts.delete(key);
    },
  };
}
