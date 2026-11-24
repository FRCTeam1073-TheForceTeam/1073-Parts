import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { db, dataDir, getSettings, saveSettings } from './db.js';
import * as suppliers from './suppliers.js';
import * as auth from './auth.js';
import * as onshape from './onshape.js';
import { createBackup } from './backup.js';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const root = path.dirname(fileURLToPath(import.meta.url));

if (process.env.TRUST_PROXY) app.set('trust proxy', true);

// Basic protections for running on the public internet.
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

// Health check for the host (no login, no database work).
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use(express.json({ limit: '2mb' }));
app.use(auth.loadUser);

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(err.status && err.status < 500 ? 400 : 500).json({ error: err.message });
  });
};
const isSecure = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';
const mentor = auth.requireRole('mentor');
const admin = auth.requireRole('admin');

// ---------------------------------------------------------------------------
// Accounts

app.get('/api/auth', (req, res) => {
  const setup = auth.userCount() === 0;
  res.json({ setup, setupNeedsCode: setup && !!process.env.SETUP_CODE, user: auth.publicUser(req.user) });
});

// First run only: create the first admin account.
app.post('/api/setup', wrap((req, res) => {
  if (auth.userCount() > 0) return res.status(400).json({ error: 'Setup is already done.' });
  // On a public server, SETUP_CODE stops a stranger from creating the first admin before you do.
  if (process.env.SETUP_CODE) {
    const given = Buffer.from(String(req.body?.setup_code || ''));
    const want = Buffer.from(process.env.SETUP_CODE);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      return res.status(403).json({ error: 'Wrong setup code.' });
    }
  }
  const { username, display_name, password } = req.body || {};
  if (!username?.trim() || !display_name?.trim()) return res.status(400).json({ error: 'Username and name are required.' });
  const bad = auth.validatePassword(password);
  if (bad) return res.status(400).json({ error: bad });
  const { lastInsertRowid } = db.prepare('INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(username.trim(), display_name.trim(), auth.hashPassword(password), 'admin');
  auth.startSession(res, Number(lastInsertRowid), isSecure(req));
  res.json({ ok: true });
}));

app.post('/api/login', wrap((req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const key = `${req.ip}:${username.toLowerCase()}`;
  if (auth.loginThrottled(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || u.disabled || !auth.verifyPassword(password, u.password_hash)) {
    auth.recordFailedLogin(key);
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  auth.clearFailedLogins(key);
  auth.startSession(res, u.id, isSecure(req));
  res.json({ user: auth.publicUser(u) });
}));

app.post('/api/logout', (req, res) => {
  auth.endSession(req, res);
  res.json({ ok: true });
});

app.use('/api', auth.requireUser);

app.patch('/api/me', wrap((req, res) => {
  const { display_name, current_password, new_password } = req.body || {};
  if (display_name?.trim()) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name.trim(), req.user.id);
  if (new_password) {
    if (!auth.verifyPassword(String(current_password || ''), req.user.password_hash)) {
      return res.status(400).json({ error: 'Current password is wrong.' });
    }
    const bad = auth.validatePassword(new_password);
    if (bad) return res.status(400).json({ error: bad });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(new_password), req.user.id);
    auth.endAllSessions(req.user.id);
    auth.startSession(res, req.user.id, isSecure(req));
  }
  res.json({ user: auth.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
}));

app.get('/api/users', mentor, (req, res) => {
  res.json(db.prepare('SELECT * FROM users ORDER BY role DESC, display_name COLLATE NOCASE').all().map(auth.publicUser));
});

app.post('/api/users', admin, wrap((req, res) => {
  const { username, display_name, role = 'student', password } = req.body || {};
  if (!username?.trim() || !display_name?.trim()) return res.status(400).json({ error: 'Username and name are required.' });
  if (!auth.ROLES.includes(role)) return res.status(400).json({ error: 'Bad role' });
  const bad = auth.validatePassword(password);
  if (bad) return res.status(400).json({ error: bad });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username.trim())) {
    return res.status(400).json({ error: 'That username is taken.' });
  }
  const { lastInsertRowid } = db.prepare('INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(username.trim(), display_name.trim(), auth.hashPassword(password), role);
  res.json(auth.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid)));
}));

function activeAdminCount(exceptId) {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?").get(exceptId).n;
}

app.patch('/api/users/:id', admin, wrap((req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const { display_name, role, disabled, password } = req.body || {};
  const losingAdmin = u.role === 'admin' && ((role && role !== 'admin') || disabled);
  if (losingAdmin && activeAdminCount(id) === 0) return res.status(400).json({ error: 'The team needs at least one admin.' });
  if (role && !auth.ROLES.includes(role)) return res.status(400).json({ error: 'Bad role' });
  if (display_name?.trim()) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name.trim(), id);
  if (role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  if (disabled != null) {
    db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
    if (disabled) auth.endAllSessions(id);
  }
  if (password) {
    const bad = auth.validatePassword(password);
    if (bad) return res.status(400).json({ error: bad });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(password), id);
    auth.endAllSessions(id);
  }
  res.json(auth.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
}));

app.delete('/api/users/:id', admin, wrap((req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (id === req.user.id) return res.status(400).json({ error: "You can't delete your own account." });
  if (u.role === 'admin' && activeAdminCount(id) === 0) return res.status(400).json({ error: 'The team needs at least one admin.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Helpers

const ORDER_FIELDS = [
  'name', 'description', 'supplier', 'sku', 'url', 'image', 'product_id', 'variant_id', 'variant_title',
  'unit_price_cents', 'quantity', 'mechanism_id', 'status', 'priority', 'requested_by', 'notes',
  'order_number', 'tracking_number', 'carrier',
];
// Fields a student may set on their own request.
const STUDENT_ORDER_FIELDS = [
  'name', 'description', 'supplier', 'sku', 'url', 'image', 'product_id', 'variant_id', 'variant_title',
  'unit_price_cents', 'quantity', 'mechanism_id', 'priority', 'notes',
];
// Changing any of these on an approved request sends it back for approval.
const APPROVAL_SENSITIVE = ['quantity', 'unit_price_cents', 'variant_id', 'product_id', 'supplier', 'sku'];
const INVENTORY_FIELDS = [
  'name', 'description', 'supplier', 'sku', 'url', 'image', 'product_id', 'variant_id', 'variant_title',
  'unit_price_cents', 'quantity', 'location', 'mechanism_id', 'notes', 'min_quantity',
];
const STATUSES = ['needed', 'ordered', 'arrived'];

function pick(body, fields) {
  const out = {};
  for (const f of fields) if (f in body) out[f] = body[f] === '' ? null : body[f];
  return out;
}

function insert(table, data) {
  const keys = Object.keys(data);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  const { lastInsertRowid } = db.prepare(sql).run(...keys.map((k) => data[k]));
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(lastInsertRowid);
}

function update(table, id, data, extraSql = '') {
  const keys = Object.keys(data);
  if (keys.length || extraSql) {
    const sets = keys.map((k) => `${k} = ?`);
    if (extraSql) sets.push(extraSql);
    db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...keys.map((k) => data[k]), id);
  }
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

// Track ordered/arrived timestamps as status moves.
function statusTimestamps(status) {
  if (status === 'needed') return 'ordered_at = NULL, arrived_at = NULL';
  if (status === 'ordered') return "ordered_at = COALESCE(ordered_at, datetime('now')), arrived_at = NULL";
  if (status === 'arrived') return "ordered_at = COALESCE(ordered_at, datetime('now')), arrived_at = COALESCE(arrived_at, datetime('now'))";
  return '';
}

// Does a new request from this user need a mentor's OK?
function needsApproval(user, data) {
  if (auth.isAtLeast(user, 'mentor')) return false;
  const s = getSettings();
  if (s.require_approval !== '1') return false;
  const threshold = Number(s.approval_threshold_cents) || 0;
  const total = (Number(data.unit_price_cents) || 0) * (Number(data.quantity) || 0);
  return total > threshold || data.unit_price_cents == null;
}

// Find the inventory row that represents the same product as an order.
function findInventoryMatch({ supplier, variant_id, sku, name }) {
  if (supplier && variant_id) {
    const r = db.prepare('SELECT * FROM inventory WHERE supplier = ? AND variant_id = ?').get(supplier, String(variant_id));
    if (r) return r;
  }
  if (sku) {
    const r = db.prepare('SELECT * FROM inventory WHERE lower(sku) = lower(?)').get(sku);
    if (r) return r;
  }
  if (name) return db.prepare('SELECT * FROM inventory WHERE lower(name) = lower(?)').get(name);
  return undefined;
}

function getOrder(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id));
}

function createOrder(user, body) {
  const fields = auth.isAtLeast(user, 'mentor') ? ORDER_FIELDS : STUDENT_ORDER_FIELDS;
  const data = pick(body, fields);
  if (!data.name) {
    const err = new Error('Part name required');
    err.status = 400;
    throw err;
  }
  if (data.status && !STATUSES.includes(data.status)) data.status = 'needed';
  data.created_by = user.id;
  if (!data.requested_by) data.requested_by = user.display_name;
  data.approval = needsApproval(user, data) ? 'pending' : 'approved';
  if (data.approval === 'pending') data.status = 'needed';
  const row = insert('orders', data);
  return data.status && data.status !== 'needed' ? update('orders', row.id, {}, statusTimestamps(data.status)) : row;
}

// ---------------------------------------------------------------------------
// Meta, settings, mechanisms

app.get('/api/meta', (req, res) => {
  res.json({
    user: auth.publicUser(req.user),
    suppliers: suppliers.publicSuppliers(),
    mechanisms: db.prepare('SELECT * FROM mechanisms ORDER BY sort, name').all(),
    settings: getSettings(),
    columns: db.prepare('SELECT * FROM board_columns ORDER BY sort, id').all(),
    team: db.prepare('SELECT id, display_name FROM users WHERE disabled = 0 ORDER BY display_name COLLATE NOCASE').all(),
    onshapeConnected: onshape.isConfigured(),
    vendors: db.prepare('SELECT * FROM vendors ORDER BY name COLLATE NOCASE').all(),
  });
});

app.put('/api/settings', mentor, wrap((req, res) => {
  res.json(saveSettings(req.body || {}));
}));

app.post('/api/mechanisms', mentor, wrap((req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM mechanisms').get().s;
  res.json(insert('mechanisms', { name, color: req.body.color || '#64748b', sort }));
}));

app.patch('/api/mechanisms/:id', mentor, wrap((req, res) => {
  res.json(update('mechanisms', Number(req.params.id), pick(req.body, ['name', 'color', 'sort', 'budget_cents'])));
}));

app.delete('/api/mechanisms/:id', mentor, wrap((req, res) => {
  db.prepare('DELETE FROM mechanisms WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Orders

app.get('/api/orders', (req, res) => {
  res.json(db.prepare('SELECT * FROM orders ORDER BY created_at DESC, id DESC').all());
});

app.post('/api/orders', wrap((req, res) => {
  res.json(createOrder(req.user, req.body || {}));
}));

// Create many at once (BOM import, restock).
app.post('/api/orders/bulk', wrap((req, res) => {
  const list = Array.isArray(req.body?.orders) ? req.body.orders.slice(0, 500) : [];
  db.exec('BEGIN');
  try {
    const created = list.map((o) => createOrder(req.user, o));
    db.exec('COMMIT');
    res.json(created);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}));

app.patch('/api/orders/:id', wrap((req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const isMentor = auth.isAtLeast(req.user, 'mentor');

  if (!isMentor) {
    if (order.created_by !== req.user.id) return res.status(403).json({ error: 'You can only edit your own requests.' });
    if (order.status !== 'needed') return res.status(403).json({ error: 'This part has already been ordered.' });
  }
  const data = pick(req.body, isMentor ? ORDER_FIELDS : STUDENT_ORDER_FIELDS);
  if (data.status && !STATUSES.includes(data.status)) return res.status(400).json({ error: 'Bad status' });
  if (data.status && data.status !== 'needed' && order.approval !== 'approved' && !('approval' in req.body)) {
    return res.status(400).json({ error: 'This request has not been approved yet.' });
  }
  // A student changing what or how much to buy needs a fresh approval.
  if (!isMentor) {
    const merged = { ...order, ...data };
    const changed = APPROVAL_SENSITIVE.some((k) => k in data && String(data[k] ?? '') !== String(order[k] ?? ''));
    if ((changed || order.approval === 'rejected') && needsApproval(req.user, merged)) {
      Object.assign(data, { approval: 'pending', approved_by: null, approved_at: null, rejection_reason: null });
    }
  }
  res.json(update('orders', order.id, data, data.status ? statusTimestamps(data.status) : ''));
}));

app.post('/api/orders/:id/approve', mentor, wrap((req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json(update('orders', order.id, { approval: 'approved', approved_by: req.user.display_name, rejection_reason: null }, "approved_at = datetime('now')"));
}));

app.post('/api/orders/:id/reject', mentor, wrap((req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json(update('orders', order.id, {
    approval: 'rejected', approved_by: req.user.display_name, rejection_reason: String(req.body?.reason || '').trim() || null,
  }, "approved_at = datetime('now')"));
}));

app.post('/api/orders/bulk-approve', mentor, wrap((req, res) => {
  const ids = (req.body?.ids || []).map(Number);
  for (const id of ids) update('orders', id, { approval: 'approved', approved_by: req.user.display_name, rejection_reason: null }, "approved_at = datetime('now')");
  res.json({ ok: true });
}));

// Change status for many orders; optionally record the supplier order number and tracking.
app.post('/api/orders/bulk-status', mentor, wrap((req, res) => {
  const { ids = [], status, order_number, tracking_number, carrier } = req.body || {};
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Bad status' });
  const extra = {};
  if (order_number) extra.order_number = String(order_number).trim();
  if (tracking_number) extra.tracking_number = String(tracking_number).trim();
  if (carrier) extra.carrier = String(carrier).trim();
  let skipped = 0;
  for (const id of ids) {
    const o = getOrder(id);
    if (!o) continue;
    if (status !== 'needed' && o.approval !== 'approved') {
      skipped++;
      continue;
    }
    update('orders', o.id, { status, ...extra }, statusTimestamps(status));
  }
  res.json({ ok: true, skipped });
}));

app.post('/api/orders/bulk-tracking', mentor, wrap((req, res) => {
  const { ids = [], order_number, tracking_number, carrier } = req.body || {};
  const data = pick({ order_number, tracking_number, carrier }, ['order_number', 'tracking_number', 'carrier']);
  for (const id of ids) update('orders', Number(id), data);
  res.json({ ok: true });
}));

app.delete('/api/orders/:id', wrap((req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.json({ ok: true });
  if (!auth.isAtLeast(req.user, 'mentor') && (order.created_by !== req.user.id || order.status !== 'needed')) {
    return res.status(403).json({ error: 'You can only delete your own requests that have not been ordered.' });
  }
  db.prepare('DELETE FROM orders WHERE id = ?').run(order.id);
  res.json({ ok: true });
}));

// Mark an order arrived and put its quantity on the inventory shelf.
app.post('/api/orders/:id/receive', wrap((req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const qty = Math.max(0, Number(req.body?.quantity ?? order.quantity) || 0);
  const location = req.body?.location || null;

  db.exec('BEGIN');
  try {
    let item = findInventoryMatch(order);
    if (item) {
      item = update('inventory', item.id, location ? { location } : {}, `quantity = quantity + ${qty}, updated_at = datetime('now')`);
    } else {
      const data = pick(order, INVENTORY_FIELDS.filter((f) => f !== 'min_quantity'));
      item = insert('inventory', { ...data, quantity: qty, location });
    }
    const updated = update('orders', order.id, { status: 'arrived' }, statusTimestamps('arrived'));
    db.exec('COMMIT');
    res.json({ order: updated, inventory: item });
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}));

app.get('/api/orders.csv', (req, res) => {
  const mechs = Object.fromEntries(db.prepare('SELECT id, name FROM mechanisms').all().map((m) => [m.id, m.name]));
  const rows = db.prepare('SELECT * FROM orders ORDER BY supplier, id').all();
  const cols = ['id', 'status', 'approval', 'name', 'supplier', 'sku', 'quantity', 'unit_price', 'total', 'mechanism', 'priority',
    'requested_by', 'approved_by', 'order_number', 'tracking_number', 'url', 'notes', 'created_at', 'ordered_at', 'arrived_at'];
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [cols.join(',')];
  for (const r of rows) {
    const unit = r.unit_price_cents != null ? (r.unit_price_cents / 100).toFixed(2) : '';
    const total = r.unit_price_cents != null ? ((r.unit_price_cents * r.quantity) / 100).toFixed(2) : '';
    lines.push(cols.map((c) => esc(
      c === 'unit_price' ? unit : c === 'total' ? total : c === 'mechanism' ? mechs[r.mechanism_id] : r[c],
    )).join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
  res.send(lines.join('\n'));
});

// ---------------------------------------------------------------------------
// Inventory

app.get('/api/inventory', (req, res) => {
  res.json(db.prepare('SELECT * FROM inventory ORDER BY name COLLATE NOCASE').all());
});

app.post('/api/inventory', wrap((req, res) => {
  const data = pick(req.body, INVENTORY_FIELDS);
  if (!data.name) return res.status(400).json({ error: 'Name required' });
  // Adding something we already track just bumps the count.
  const existing = findInventoryMatch(data);
  if (existing && req.body.merge !== false) {
    return res.json(update('inventory', existing.id, {}, `quantity = quantity + ${Number(data.quantity) || 0}, updated_at = datetime('now')`));
  }
  res.json(insert('inventory', data));
}));

app.patch('/api/inventory/:id', wrap((req, res) => {
  const data = pick(req.body, INVENTORY_FIELDS);
  if ('quantity' in data) data.quantity = Math.max(0, Number(data.quantity) || 0);
  if ('min_quantity' in data) data.min_quantity = Math.max(0, Number(data.min_quantity) || 0);
  res.json(update('inventory', Number(req.params.id), data, "updated_at = datetime('now')"));
}));

app.delete('/api/inventory/:id', mentor, wrap((req, res) => {
  db.prepare('DELETE FROM inventory WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

// Turn low-stock inventory rows into part requests: [{ id, quantity }].
app.post('/api/inventory/reorder', wrap((req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const created = [];
  db.exec('BEGIN');
  try {
    for (const { id, quantity } of items) {
      const inv = db.prepare('SELECT * FROM inventory WHERE id = ?').get(Number(id));
      if (!inv || !(Number(quantity) > 0)) continue;
      const data = pick(inv, ['name', 'description', 'supplier', 'sku', 'url', 'image', 'product_id', 'variant_id', 'variant_title', 'unit_price_cents', 'mechanism_id']);
      created.push(createOrder(req.user, { ...data, quantity: Number(quantity), notes: `Restock (min ${inv.min_quantity}, had ${inv.quantity})` }));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json(created);
}));

// ---------------------------------------------------------------------------
// Custom parts (made in-house) and the manufacturing board

const CUSTOM_FIELDS = [
  'name', 'part_number', 'cad_url', 'mechanism_id', 'quantity', 'quantity_done', 'material', 'process',
  'column_id', 'priority', 'assigned_to', 'designer', 'due_date', 'notes', 'image',
];

const boardColumns = () => db.prepare('SELECT * FROM board_columns ORDER BY sort, id').all();
const getCustom = (id) => db.prepare('SELECT * FROM custom_parts WHERE id = ?').get(Number(id));
const nextSort = (columnId) => db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM custom_parts WHERE column_id IS ?').get(columnId).s;

// started_at: first time a part leaves the first column. done_at: while it sits in the last column.
function columnTimestamps(columnId) {
  const cols = boardColumns();
  const idx = cols.findIndex((c) => c.id === Number(columnId));
  const parts = [];
  if (idx > 0) parts.push("started_at = COALESCE(started_at, datetime('now'))");
  if (idx === cols.length - 1) parts.push("done_at = COALESCE(done_at, datetime('now'))", 'quantity_done = MAX(quantity_done, quantity)');
  else parts.push('done_at = NULL');
  return parts.join(', ');
}

function createCustom(user, body) {
  const data = pick(body, CUSTOM_FIELDS);
  if (!data.name?.trim()) {
    const err = new Error('Part name required');
    err.status = 400;
    throw err;
  }
  data.name = data.name.trim();
  if (!data.column_id) data.column_id = boardColumns()[0]?.id ?? null;
  data.sort = nextSort(data.column_id);
  data.created_by = user.id;
  const row = insert('custom_parts', data);
  return update('custom_parts', row.id, {}, columnTimestamps(row.column_id));
}

const PUBLIC_FILE = 'id, custom_part_id, name, size, uploaded_by, created_at';
const filesFor = (partId) => db.prepare(`SELECT ${PUBLIC_FILE} FROM part_files WHERE custom_part_id = ? ORDER BY id`).all(partId);
const withFiles = (part) => part && { ...part, files: filesFor(part.id) };

// Files are uploaded before the part is saved, then attached by id. Only your own unattached uploads can be attached.
function attachFiles(user, partId, fileIds) {
  if (!Array.isArray(fileIds)) return;
  const stmt = db.prepare('UPDATE part_files SET custom_part_id = ? WHERE id = ? AND custom_part_id IS NULL AND uploaded_by = ?');
  for (const id of fileIds) stmt.run(partId, Number(id), user.id);
}

app.get('/api/custom-parts', (req, res) => {
  const files = db.prepare(`SELECT ${PUBLIC_FILE} FROM part_files WHERE custom_part_id IS NOT NULL ORDER BY id`).all();
  const byPart = new Map();
  for (const f of files) byPart.set(f.custom_part_id, [...(byPart.get(f.custom_part_id) || []), f]);
  res.json(db.prepare('SELECT * FROM custom_parts ORDER BY sort, id').all().map((p) => ({ ...p, files: byPart.get(p.id) || [] })));
});

app.post('/api/custom-parts', wrap((req, res) => {
  const part = createCustom(req.user, req.body || {});
  attachFiles(req.user, part.id, req.body?.file_ids);
  res.json(withFiles(part));
}));

app.post('/api/custom-parts/bulk', wrap((req, res) => {
  const list = Array.isArray(req.body?.parts) ? req.body.parts.slice(0, 500) : [];
  db.exec('BEGIN');
  try {
    const created = list.map((p) => createCustom(req.user, p));
    db.exec('COMMIT');
    res.json(created);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}));

app.patch('/api/custom-parts/:id', wrap((req, res) => {
  const part = getCustom(req.params.id);
  if (!part) return res.status(404).json({ error: 'Not found' });
  const data = pick(req.body, CUSTOM_FIELDS);
  if ('quantity_done' in data) data.quantity_done = Math.max(0, Number(data.quantity_done) || 0);
  const moved = 'column_id' in data && Number(data.column_id) !== part.column_id;
  if (moved) data.sort = nextSort(data.column_id);
  const extra = ["updated_at = datetime('now')"];
  if (moved) extra.push(columnTimestamps(data.column_id));
  const updated = update('custom_parts', part.id, data, extra.join(', '));
  attachFiles(req.user, part.id, req.body?.file_ids);
  res.json(withFiles(updated));
}));

// Drag and drop: put a part in a column, before another card (or at the end).
app.post('/api/custom-parts/:id/move', wrap((req, res) => {
  const part = getCustom(req.params.id);
  if (!part) return res.status(404).json({ error: 'Not found' });
  const columnId = Number(req.body?.column_id);
  if (!boardColumns().some((c) => c.id === columnId)) return res.status(400).json({ error: 'Unknown column' });
  const cards = db.prepare('SELECT id, sort FROM custom_parts WHERE column_id = ? AND id != ? ORDER BY sort, id').all(columnId, part.id);
  const beforeIdx = req.body?.before_id ? cards.findIndex((c) => c.id === Number(req.body.before_id)) : -1;
  let sort;
  if (beforeIdx < 0) sort = (cards.at(-1)?.sort ?? 0) + 1;
  else if (beforeIdx === 0) sort = cards[0].sort - 1;
  else sort = (cards[beforeIdx - 1].sort + cards[beforeIdx].sort) / 2;
  const extra = ["updated_at = datetime('now')"];
  if (columnId !== part.column_id) extra.push(columnTimestamps(columnId));
  res.json(update('custom_parts', part.id, { column_id: columnId, sort }, extra.join(', ')));
}));

app.delete('/api/custom-parts/:id', wrap((req, res) => {
  const part = getCustom(req.params.id);
  if (!part) return res.json({ ok: true });
  if (!auth.isAtLeast(req.user, 'mentor') && part.created_by !== req.user.id) {
    return res.status(403).json({ error: 'Only mentors or the person who added it can delete this part.' });
  }
  const files = db.prepare('SELECT stored_name FROM part_files WHERE custom_part_id = ?').all(part.id);
  db.prepare('DELETE FROM part_files WHERE custom_part_id = ?').run(part.id);
  db.prepare('DELETE FROM custom_parts WHERE id = ?').run(part.id);
  files.forEach((f) => removeStoredFile(f.stored_name));
  res.json({ ok: true });
}));

app.post('/api/board-columns', mentor, wrap((req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM board_columns').get().s;
  res.json(insert('board_columns', { name, color: req.body.color || '#64748b', sort }));
}));

app.patch('/api/board-columns/:id', mentor, wrap((req, res) => {
  res.json(update('board_columns', Number(req.params.id), pick(req.body, ['name', 'color', 'sort'])));
}));

// Remove a column; its cards move to the first remaining column.
app.delete('/api/board-columns/:id', mentor, wrap((req, res) => {
  const id = Number(req.params.id);
  const rest = boardColumns().filter((c) => c.id !== id);
  if (!rest.length) return res.status(400).json({ error: 'The board needs at least one column.' });
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE custom_parts SET column_id = ? WHERE column_id = ?').run(rest[0].id, id);
    db.prepare('DELETE FROM board_columns WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Vendors (suppliers that aren't built in)

const VENDOR_COLORS = ['#0ea5e9', '#a855f7', '#f43f5e', '#22c55e', '#eab308', '#14b8a6', '#f97316', '#6366f1'];
const isBuiltIn = (name) => suppliers.SUPPLIERS.some((s) => s.key === name.toLowerCase() || s.name.toLowerCase() === name.toLowerCase());

// Anyone can add a vendor (e.g. while adding a part). Adding an existing name returns it.
app.post('/api/vendors', wrap((req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Vendor name required' });
  if (isBuiltIn(name)) return res.status(400).json({ error: `${name} is already a built-in supplier.` });
  const existing = db.prepare('SELECT * FROM vendors WHERE name = ?').get(name);
  if (existing) return res.json(existing);
  const count = db.prepare('SELECT COUNT(*) AS n FROM vendors').get().n;
  res.json(insert('vendors', { name, website: String(req.body.website || '').trim() || null, color: req.body.color || VENDOR_COLORS[count % VENDOR_COLORS.length] }));
}));

// Renaming a vendor also renames it on existing orders and inventory.
app.patch('/api/vendors/:id', mentor, wrap((req, res) => {
  const v = db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'Not found' });
  const data = pick(req.body, ['name', 'website', 'color']);
  if (data.name != null) {
    data.name = String(data.name).trim();
    if (!data.name) return res.status(400).json({ error: 'Vendor name required' });
    if (isBuiltIn(data.name)) return res.status(400).json({ error: `${data.name} is already a built-in supplier.` });
  }
  db.exec('BEGIN');
  try {
    const updated = update('vendors', v.id, data);
    if (data.name && data.name !== v.name) {
      db.prepare('UPDATE orders SET supplier = ? WHERE supplier = ?').run(data.name, v.name);
      db.prepare('UPDATE inventory SET supplier = ? WHERE supplier = ?').run(data.name, v.name);
    }
    db.exec('COMMIT');
    res.json(updated);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}));

// Removing a vendor keeps its name on existing orders; it just leaves the list.
app.delete('/api/vendors/:id', mentor, wrap((req, res) => {
  db.prepare('DELETE FROM vendors WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Onshape

// Admins save the team's API keys. They are never sent back to the browser.
app.put('/api/onshape/keys', admin, wrap(async (req, res) => {
  const { access_key, secret_key } = req.body || {};
  if (!access_key?.trim() || !secret_key?.trim()) return res.status(400).json({ error: 'Both keys are required.' });
  onshape.saveKeys(access_key, secret_key);
  try {
    res.json({ ok: true, ...(await onshape.testConnection()) });
  } catch (err) {
    onshape.saveKeys('', ''); // don't keep keys that don't work
    res.status(400).json({ error: err.message });
  }
}));

app.delete('/api/onshape/keys', admin, (req, res) => {
  onshape.saveKeys('', '');
  res.json({ ok: true });
});

// Parts from an Onshape assembly (BOM) or Part Studio link, shaped like CSV BOM rows.
app.post('/api/onshape/bom', wrap(async (req, res) => {
  res.json(await onshape.fetchParts(req.body?.url));
}));

// ---------------------------------------------------------------------------
// Supplier catalog

app.get('/api/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [], errors: [] });
  const keys = req.query.suppliers ? String(req.query.suppliers).split(',') : undefined;
  res.json(await suppliers.search(q, keys, Math.min(Number(req.query.limit) || 8, 20)));
}));

app.get('/api/product', wrap(async (req, res) => {
  res.json(await suppliers.product(String(req.query.supplier), String(req.query.handle)));
}));

// Other sizes of the same part sold as separate products (e.g. WCP gears).
app.get('/api/siblings', wrap(async (req, res) => {
  res.json(await suppliers.siblings(String(req.query.supplier), String(req.query.handle || ''), String(req.query.title || ''), req.query.product_id ? String(req.query.product_id) : null));
}));

app.get('/api/lookup', wrap(async (req, res) => {
  const p = await suppliers.lookupUrl(String(req.query.url || ''));
  if (!p) return res.status(400).json({ error: 'That supplier is not supported for auto-fill yet. Enter the details by hand.' });
  res.json(p);
}));

// Match BOM part numbers to supplier products: rows = [{ partNumber, description }].
app.post('/api/match', wrap(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 60) : [];
  const out = new Array(rows.length).fill(null);
  let next = 0;
  // A few at a time so supplier sites don't rate-limit us.
  const worker = async () => {
    while (next < rows.length) {
      const i = next++;
      try {
        out[i] = await suppliers.matchSku(rows[i].partNumber, { description: rows[i].description });
      } catch {
        out[i] = null;
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  res.json(out.map((m, i) => ({
    index: i,
    supplier: m?.product.supplier || suppliers.supplierForSku(rows[i].partNumber)?.key || null,
    match: m,
  })));
}));

// Build a supplier cart from approved "needed" orders (defaults to all of them for that supplier).
app.post('/api/cart', mentor, wrap((req, res) => {
  const { supplier, orderIds } = req.body || {};
  const rows = (orderIds?.length
    ? db.prepare(`SELECT * FROM orders WHERE id IN (${orderIds.map(() => '?').join(',')})`).all(...orderIds.map(Number))
    : db.prepare("SELECT * FROM orders WHERE supplier = ? AND status = 'needed'").all(supplier))
    .filter((r) => r.supplier === supplier && r.approval === 'approved');
  const items = rows.map((r) => ({
    orderIds: [r.id], name: r.name, quantity: r.quantity, variantId: r.variant_id, productId: r.product_id, sku: r.sku, url: r.url,
  }));
  const cart = suppliers.buildCart(supplier, items);
  res.json({ ...cart, orderIds: items.map((i) => i.orderIds[0]) });
}));

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Photos (parts not from a vendor, custom parts). The browser shrinks them before uploading.

const uploadsDir = path.resolve(dataDir, 'uploads'); // absolute: res.sendFile rejects relative paths
mkdirSync(uploadsDir, { recursive: true });
const IMAGE_TYPES = {
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  'image/png': { ext: 'png', magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  'image/webp': { ext: 'webp', magic: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  'image/gif': { ext: 'gif', magic: (b) => b.toString('ascii', 0, 3) === 'GIF' },
};

// Detect the image type from its first bytes (don't trust the name or header).
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  return Object.values(IMAGE_TYPES).find((t) => t.magic(buf)) || null;
}

function saveImage(buf) {
  const type = sniffImage(buf);
  if (!type) return null;
  const name = `${crypto.randomBytes(16).toString('hex')}.${type.ext}`;
  mkdirSync(uploadsDir, { recursive: true });
  writeFileSync(path.join(uploadsDir, name), buf);
  return `/api/uploads/${name}`;
}

app.post('/api/uploads', express.raw({ type: 'image/*', limit: '8mb' }), wrap((req, res) => {
  const url = IMAGE_TYPES[String(req.headers['content-type'] || '').split(';')[0].trim()] ? saveImage(req.body) : null;
  if (!url) return res.status(400).json({ error: 'Upload a JPEG, PNG, WebP or GIF image.' });
  res.json({ url });
}));

// Copying an image on a website often gives a link instead of the picture. Fetch it here.
// Only public http(s) addresses are allowed, so this can't be used to reach machines on the school network.
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

async function fetchPublicImage(rawUrl) {
  let url = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    let u;
    try {
      u = new URL(url);
    } catch {
      throw Object.assign(new Error("That isn't a link to an image."), { status: 400 });
    }
    if (!['http:', 'https:'].includes(u.protocol)) throw Object.assign(new Error('Only web (http/https) image links work.'), { status: 400 });
    const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
      throw Object.assign(new Error("That image's website couldn't be reached."), { status: 400 });
    }
    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FRC1073-PartsTracker)', Accept: 'image/*' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), u).href;
      continue;
    }
    if (!res.ok) throw Object.assign(new Error(`The image's website responded ${res.status}.`), { status: 400 });
    if (Number(res.headers.get('content-length')) > 8 * 1024 * 1024) throw Object.assign(new Error('That image is too large (over 8 MB).'), { status: 400 });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) throw Object.assign(new Error('That image is too large (over 8 MB).'), { status: 400 });
    return buf;
  }
  throw Object.assign(new Error('That image link redirects too many times.'), { status: 400 });
}

app.post('/api/uploads/from-url', wrap(async (req, res) => {
  const buf = await fetchPublicImage(String(req.body?.url || '').trim());
  const url = saveImage(buf);
  if (!url) return res.status(400).json({ error: "That link isn't a JPEG, PNG, WebP or GIF image. Try right-click → Copy image instead." });
  res.json({ url });
}));

// ---------------------------------------------------------------------------
// Part files (STEP, STL, 3MF, DXF, G-code, PDF drawings) attached to custom parts.

const filesDir = path.resolve(dataDir, 'files');
mkdirSync(filesDir, { recursive: true });
const FILE_TYPES = ['step', 'stp', 'stl', '3mf', 'obj', 'dxf', 'dwg', 'gcode', 'bgcode', 'f3d', 'sldprt', 'pdf'];
const MAX_FILE_MB = 100;

function removeStoredFile(storedName) {
  try {
    unlinkSync(path.join(filesDir, storedName));
  } catch {
    // already gone
  }
}

// Body is the raw file; ?name= carries the original file name.
app.post('/api/files', express.raw({ type: () => true, limit: `${MAX_FILE_MB}mb` }), wrap((req, res) => {
  const name = path.basename(String(req.query.name || '')).replace(/[\u0000-\u001f"]/g, '').slice(0, 200);
  const ext = name.split('.').pop().toLowerCase();
  if (!name || !FILE_TYPES.includes(ext)) {
    return res.status(400).json({ error: `Attach a ${FILE_TYPES.map((t) => '.' + t).join(', ')} file.` });
  }
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'That file is empty.' });
  const storedName = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  mkdirSync(filesDir, { recursive: true });
  writeFileSync(path.join(filesDir, storedName), req.body);
  const row = insert('part_files', { name, stored_name: storedName, size: req.body.length, uploaded_by: req.user.id });
  res.json({ id: row.id, name: row.name, size: row.size, custom_part_id: null });
}));

// Downloads always save as a file (never open in the browser).
app.get('/api/files/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM part_files WHERE id = ?').get(Number(req.params.id));
  if (!f) return res.status(404).json({ error: 'File not found' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.download(path.join(filesDir, f.stored_name), f.name, { headers: { 'Content-Type': 'application/octet-stream' } },
    (err) => err && !res.headersSent && res.status(404).json({ error: 'File missing on the server' }));
});

app.delete('/api/files/:id', wrap((req, res) => {
  const f = db.prepare('SELECT * FROM part_files WHERE id = ?').get(Number(req.params.id));
  if (!f) return res.json({ ok: true });
  if (!auth.isAtLeast(req.user, 'mentor') && f.uploaded_by !== req.user.id) {
    return res.status(403).json({ error: 'Only mentors or the person who attached it can remove this file.' });
  }
  db.prepare('DELETE FROM part_files WHERE id = ?').run(f.id);
  removeStoredFile(f.stored_name);
  res.json({ ok: true });
}));

// Uploads never attached to a part (window closed without saving) are cleared after a day.
for (const f of db.prepare("SELECT id, stored_name FROM part_files WHERE custom_part_id IS NULL AND created_at < datetime('now', '-1 day')").all()) {
  db.prepare('DELETE FROM part_files WHERE id = ?').run(f.id);
  removeStoredFile(f.stored_name);
}

// Only signed-in team members can see photos.
app.get('/api/uploads/:name', (req, res) => {
  if (!/^[0-9a-f]{32}\.(jpg|png|webp|gif)$/.test(req.params.name)) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(path.join(uploadsDir, req.params.name), (err) => err && !res.headersSent && res.status(404).end());
});

// Admins download everything (database + photos + part files) as one .tar file.
app.get('/api/admin/backup', admin, (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  try {
    const chunks = [...createBackup(path.resolve(dataDir))];
    res.setHeader('Content-Type', 'application/x-tar');
    res.setHeader('Content-Disposition', `attachment; filename="parts-backup-${stamp}.tar"`);
    for (const chunk of chunks) res.write(chunk);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Backup failed' });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
// 3D viewer libraries, served from node_modules so the viewer works without internet access.
const modules = path.join(root, '..', 'node_modules');
app.use('/vendor/three', express.static(path.join(modules, 'three'), { maxAge: '30d' }));
app.use('/vendor/occt', express.static(path.join(modules, 'occt-import-js', 'dist'), { maxAge: '30d' }));
app.use(express.static(path.join(root, '..', 'public')));
app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(root, '..', 'public', 'index.html')));

// Put supplier names typed on existing orders/inventory (before the vendor list existed) into the list.
for (const { supplier } of db.prepare("SELECT DISTINCT supplier FROM orders WHERE supplier IS NOT NULL AND supplier != '' UNION SELECT DISTINCT supplier FROM inventory WHERE supplier IS NOT NULL AND supplier != ''").all()) {
  if (!isBuiltIn(supplier)) db.prepare('INSERT OR IGNORE INTO vendors (name) VALUES (?)').run(supplier);
}

// Close the database cleanly when the host stops or restarts the app.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    try {
      db.close();
    } finally {
      process.exit(0);
    }
  });
}

app.listen(PORT, () => {
  console.log(`Parts tracker running at http://localhost:${PORT}`);
  if (auth.userCount() === 0) console.log('No accounts yet: open the site to create the first admin.');
});
