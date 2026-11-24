// Team accounts: password hashing, sessions, and role checks.
import crypto from 'node:crypto';
import { db } from './db.js';

export const ROLES = ['student', 'mentor', 'admin'];
const SESSION_DAYS = 180;
const COOKIE = 'pt_session';

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

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

export function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export function publicUser(u) {
  return u && { id: u.id, username: u.username, display_name: u.display_name, role: u.role, disabled: !!u.disabled, created_at: u.created_at };
}

export function startSession(res, userId, secure) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`)
    .run(sha(token), userId);
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

export function endSession(req, res) {
  const token = readToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function endAllSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function readToken(req) {
  const cookie = req.headers.cookie || '';
  for (const part of cookie.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (part.slice(0, i) === COOKIE) return part.slice(i + 1);
  }
  return null;
}

// Express middleware: attaches req.user when a valid session cookie is present.
export function loadUser(req, res, next) {
  const token = readToken(req);
  if (token) {
    const u = db.prepare(`
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.disabled = 0`).get(sha(token));
    if (u) req.user = u;
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  next();
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

// Small in-memory throttle so the login form can't be brute-forced.
const attempts = new Map();
export function loginThrottled(key) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(key, list);
  return list.length >= 10;
}
export function recordFailedLogin(key) {
  attempts.set(key, [...(attempts.get(key) || []), Date.now()]);
}
export function clearFailedLogins(key) {
  attempts.delete(key);
}
