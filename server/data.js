// The data layer: every query the app runs (schema and seeding live in db.js).
// Routes, auth and Onshape call these functions and never touch SQL themselves.
import { db, SETTING_DEFAULTS } from './db.js';

// ---------------------------------------------------------------------------
// Shared helpers

// SQLite expression for "now", in the same text format as every other timestamp column.
export const NOW = "datetime('now')";
// Extra SET clauses for UPDATE calls that stamp a time column.
export const APPROVED_NOW = `approved_at = ${NOW}`;
export const UPDATED_NOW = `updated_at = ${NOW}`;

// Run fn in one transaction: commit when it returns, roll back and rethrow when it throws.
export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getById(table, id) {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

// Table names are internal constants, never request input.
function insert(table, data) {
  const keys = Object.keys(data);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  const { lastInsertRowid } = db.prepare(sql).run(...keys.map((k) => data[k]));
  return getById(table, lastInsertRowid);
}

// extraSql is an optional SET clause (from this module's constants), e.g. APPROVED_NOW.
function update(table, id, data, extraSql = '') {
  const keys = Object.keys(data);
  if (keys.length || extraSql) {
    const sets = keys.map((k) => `${k} = ?`);
    if (extraSql) sets.push(extraSql);
    db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...keys.map((k) => data[k]), id);
  }
  return getById(table, id);
}

function remove(table, id) {
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
}

// ---------------------------------------------------------------------------
// Users

export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export function findUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

export function getUser(id) {
  return getById('users', id);
}

export function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY role DESC, display_name COLLATE NOCASE').all();
}

// Names shown in assignment pickers (active accounts only).
export function listTeam() {
  return db.prepare('SELECT id, display_name FROM users WHERE disabled = 0 ORDER BY display_name COLLATE NOCASE').all();
}

export function createUser(fields) {
  return insert('users', fields);
}

export function updateUser(id, fields) {
  return update('users', id, fields);
}

export function deleteUser(id) {
  remove('users', id);
}

export function countActiveAdmins(exceptId) {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?").get(exceptId).n;
}

// ---------------------------------------------------------------------------
// Sessions (cookie handling stays in auth.js; these store only token hashes)

export function createSession(tokenHash, userId, days) {
  db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+${Number(days)} days'))`)
    .run(tokenHash, userId);
}

export function findUserBySession(tokenHash) {
  return db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ${NOW} AND u.disabled = 0`).get(tokenHash);
}

export function deleteSession(tokenHash) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function deleteUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// ---------------------------------------------------------------------------
// Team settings (key/value; unknown keys are ignored)

export function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...SETTING_DEFAULTS };
  for (const r of rows) if (r.key in SETTING_DEFAULTS) out[r.key] = r.value;
  return out;
}

export function saveSettings(values) {
  for (const [k, v] of Object.entries(values)) if (k in SETTING_DEFAULTS) setSetting(k, v == null ? '' : String(v));
  return getSettings();
}

// ---------------------------------------------------------------------------
// Mechanisms

export function listMechanisms() {
  return db.prepare('SELECT * FROM mechanisms ORDER BY sort, name').all();
}

export function nextMechanismSort() {
  return db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM mechanisms').get().s;
}

export function createMechanism(fields) {
  return insert('mechanisms', fields);
}

export function updateMechanism(id, fields) {
  return update('mechanisms', id, fields);
}

export function deleteMechanism(id) {
  remove('mechanisms', id);
}

// ---------------------------------------------------------------------------
// Board columns and the card ordering used by the board

export function listBoardColumns() {
  return db.prepare('SELECT * FROM board_columns ORDER BY sort, id').all();
}

export function nextBoardColumnSort() {
  return db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM board_columns').get().s;
}

export function createBoardColumn(fields) {
  return insert('board_columns', fields);
}

export function updateBoardColumn(id, fields) {
  return update('board_columns', id, fields);
}

// Remove a column; its cards and the tasks for that stage move to fallbackId in the same transaction.
export function deleteBoardColumn(id, fallbackId) {
  return transaction(() => {
    db.prepare('UPDATE custom_parts SET column_id = ? WHERE column_id = ?').run(fallbackId, id);
    db.prepare('UPDATE part_tasks SET column_id = ? WHERE column_id = ?').run(fallbackId, id);
    remove('board_columns', id);
  });
}

// started_at: first time a part leaves the first column. done_at: while it sits in the last column.
export function columnTimestamps(columnId) {
  const cols = listBoardColumns();
  const idx = cols.findIndex((c) => c.id === Number(columnId));
  const parts = [];
  if (idx > 0) parts.push(`started_at = COALESCE(started_at, ${NOW})`);
  if (idx === cols.length - 1) parts.push(`done_at = COALESCE(done_at, ${NOW})`, 'quantity_done = MAX(quantity_done, quantity)');
  else parts.push('done_at = NULL');
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Vendors (suppliers that aren't built in)

export function listVendors() {
  return db.prepare('SELECT * FROM vendors ORDER BY name COLLATE NOCASE').all();
}

export function findVendorByName(name) {
  return db.prepare('SELECT * FROM vendors WHERE name = ?').get(name);
}

export function countVendors() {
  return db.prepare('SELECT COUNT(*) AS n FROM vendors').get().n;
}

export function getVendor(id) {
  return getById('vendors', id);
}

export function createVendor(fields) {
  return insert('vendors', fields);
}

export function updateVendor(id, fields) {
  return update('vendors', id, fields);
}

export function deleteVendor(id) {
  remove('vendors', id);
}

// Rename a vendor and carry the new name onto existing orders and inventory.
export function renameVendor(vendor, fields) {
  return transaction(() => {
    const updated = updateVendor(vendor.id, fields);
    if (fields.name && fields.name !== vendor.name) {
      db.prepare('UPDATE orders SET supplier = ? WHERE supplier = ?').run(fields.name, vendor.name);
      db.prepare('UPDATE inventory SET supplier = ? WHERE supplier = ?').run(fields.name, vendor.name);
    }
    return updated;
  });
}

export function ensureVendor(name) {
  db.prepare('INSERT OR IGNORE INTO vendors (name) VALUES (?)').run(name);
}

// Supplier names already typed on orders or inventory.
export function listSuppliersInUse() {
  return db.prepare("SELECT DISTINCT supplier FROM orders WHERE supplier IS NOT NULL AND supplier != '' UNION SELECT DISTINCT supplier FROM inventory WHERE supplier IS NOT NULL AND supplier != ''").all();
}

// ---------------------------------------------------------------------------
// Orders (part requests)

// SET clause for an order's ordered/arrived timestamps as its status moves.
export function statusTimestamps(status) {
  if (status === 'needed') return 'ordered_at = NULL, arrived_at = NULL';
  if (status === 'ordered') return `ordered_at = COALESCE(ordered_at, ${NOW}), arrived_at = NULL`;
  if (status === 'arrived') return `ordered_at = COALESCE(ordered_at, ${NOW}), arrived_at = COALESCE(arrived_at, ${NOW})`;
  return '';
}

export function listOrders() {
  return db.prepare('SELECT * FROM orders ORDER BY created_at DESC, id DESC').all();
}

// Every order, grouped by supplier (CSV export).
export function listOrdersBySupplier() {
  return db.prepare('SELECT * FROM orders ORDER BY supplier, id').all();
}

export function getOrder(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id));
}

export function insertOrder(fields) {
  return insert('orders', fields);
}

export function updateOrder(id, fields, extraSql = '') {
  return update('orders', id, fields, extraSql);
}

export function deleteOrder(id) {
  remove('orders', id);
}

export function ordersByIds(ids) {
  return db.prepare(`SELECT * FROM orders WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
}

export function ordersNeededFor(supplier) {
  return db.prepare("SELECT * FROM orders WHERE supplier = ? AND status = 'needed'").all(supplier);
}

// ---------------------------------------------------------------------------
// Inventory (what's on the shelf)

export function listInventory() {
  return db.prepare('SELECT * FROM inventory ORDER BY name COLLATE NOCASE').all();
}

export function getInventory(id) {
  return db.prepare('SELECT * FROM inventory WHERE id = ?').get(Number(id));
}

export function insertInventory(fields) {
  return insert('inventory', fields);
}

export function updateInventory(id, fields, extraSql = '') {
  return update('inventory', id, fields, extraSql);
}

// Add qty to an item's count (and optionally update other fields).
export function addToInventory(id, qty, fields = {}) {
  return update('inventory', id, fields, `quantity = quantity + ${Number(qty)}, ${UPDATED_NOW}`);
}

export function deleteInventory(id) {
  remove('inventory', id);
}

// Find the inventory row that represents the same product as an order (or a new inventory line).
export function findInventoryMatch({ supplier, variant_id, sku, name }) {
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

// ---------------------------------------------------------------------------
// Custom parts (made in-house) on the board

export function listCustomParts() {
  return db.prepare('SELECT * FROM custom_parts ORDER BY sort, id').all();
}

export function getCustomPart(id) {
  return db.prepare('SELECT * FROM custom_parts WHERE id = ?').get(Number(id));
}

// Next position at the end of a column.
export function nextCardSort(columnId) {
  return db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM custom_parts WHERE column_id IS ?').get(columnId).s;
}

// Cards in a column, in board order, leaving out one card (the one being moved).
export function cardsInColumn(columnId, exceptId) {
  return db.prepare('SELECT id, sort FROM custom_parts WHERE column_id = ? AND id != ? ORDER BY sort, id').all(columnId, exceptId);
}

export function insertCustomPart(fields) {
  return insert('custom_parts', fields);
}

export function updateCustomPart(id, fields, extraSql = '') {
  return update('custom_parts', id, fields, extraSql);
}

// Deletes a part with its file rows and tasks. Returns the stored file names so the caller can remove them from disk.
export function deleteCustomPart(id) {
  const stored = db.prepare('SELECT stored_name FROM part_files WHERE custom_part_id = ?').all(id);
  db.prepare('DELETE FROM part_files WHERE custom_part_id = ?').run(id);
  db.prepare('DELETE FROM part_tasks WHERE custom_part_id = ?').run(id);
  remove('custom_parts', id);
  return stored.map((f) => f.stored_name);
}

// ---------------------------------------------------------------------------
// Files attached to custom parts (the bytes live on disk; these are the records)

const PUBLIC_FILE = 'id, custom_part_id, name, size, uploaded_by, created_at';

export function listPartFilesFor(partId) {
  return db.prepare(`SELECT ${PUBLIC_FILE} FROM part_files WHERE custom_part_id = ? ORDER BY id`).all(partId);
}

export function listAttachedPartFiles() {
  return db.prepare(`SELECT ${PUBLIC_FILE} FROM part_files WHERE custom_part_id IS NOT NULL ORDER BY id`).all();
}

export function insertPartFile(fields) {
  return insert('part_files', fields);
}

// Only attaches an unattached upload made by userId.
export function attachPartFile(partId, fileId, userId) {
  db.prepare('UPDATE part_files SET custom_part_id = ? WHERE id = ? AND custom_part_id IS NULL AND uploaded_by = ?')
    .run(partId, Number(fileId), userId);
}

export function getPartFile(id) {
  return db.prepare('SELECT * FROM part_files WHERE id = ?').get(Number(id));
}

export function deletePartFile(id) {
  remove('part_files', id);
}

// Uploads never attached to a part are deleted; returns their stored names for removal from disk.
export function takeOrphanPartFiles() {
  const rows = db.prepare(`SELECT id, stored_name FROM part_files WHERE custom_part_id IS NULL AND created_at < datetime('now', '-1 day')`).all();
  for (const f of rows) remove('part_files', f.id);
  return rows.map((f) => f.stored_name);
}

// ---------------------------------------------------------------------------
// Checklist tasks on custom parts

export function listTasksFor(partId) {
  return db.prepare('SELECT * FROM part_tasks WHERE custom_part_id = ? ORDER BY sort, id').all(Number(partId));
}

// Every task, grouped by part and in checklist order (the board loads them all at once).
export function listAllTasks() {
  return db.prepare('SELECT * FROM part_tasks ORDER BY custom_part_id, sort, id').all();
}

export function getTask(id) {
  return db.prepare('SELECT * FROM part_tasks WHERE id = ?').get(Number(id));
}

// Next position at the end of a part's checklist.
export function nextTaskSort(partId) {
  return db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM part_tasks WHERE custom_part_id = ?').get(Number(partId)).s;
}

export function insertTask(fields) {
  return insert('part_tasks', fields);
}

// extraSql comes from taskDoneTimestamps().
export function updateTask(id, fields, extraSql = '') {
  return update('part_tasks', Number(id), fields, extraSql);
}

// SET clause for checking a task off (stamp the time once) or un-checking it (clear who and when).
export function taskDoneTimestamps(done) {
  return done ? `done_at = COALESCE(done_at, ${NOW})` : 'done_at = NULL, done_by = NULL';
}

export function deleteTask(id) {
  remove('part_tasks', Number(id));
}
