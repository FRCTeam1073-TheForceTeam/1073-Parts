// Team accounts: sessions and cookies. The pure parts live in auth-core.js and are re-exported here.
import crypto from 'node:crypto';
import * as data from './data.js';
import { createLoginThrottle } from './auth-core.js';

export {
  ROLES, hashPassword, verifyPassword, validatePassword, publicUser,
  isAtLeast, requireRole, requireUser,
} from './auth-core.js';

const SESSION_DAYS = 180;
const COOKIE = 'pt_session';

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

export function userCount() {
  return data.countUsers();
}

export function startSession(res, userId, secure) {
  const token = crypto.randomBytes(32).toString('base64url');
  data.createSession(sha(token), userId, SESSION_DAYS);
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

export function endSession(req, res) {
  const token = readToken(req);
  if (token) data.deleteSession(sha(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function endAllSessions(userId) {
  data.deleteUserSessions(userId);
}

export function readToken(req) {
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
    const u = data.findUserBySession(sha(token));
    if (u) req.user = u;
  }
  next();
}

// Small in-memory throttle so the login form can't be brute-forced.
const throttle = createLoginThrottle();
export const loginThrottled = (key) => throttle.throttled(key);
export const recordFailedLogin = (key) => throttle.recordFailure(key);
export const clearFailedLogins = (key) => throttle.clear(key);
