import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const dataDir = process.env.DATA_DIR || path.resolve('data');
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'parts.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS mechanisms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '#64748b',
    sort INTEGER NOT NULL DEFAULT 0
  );

  -- A part request: something the team needs to order.
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    supplier TEXT,              -- supplier key (wcp, rev, ...) or free text
    sku TEXT,
    url TEXT,
    image TEXT,
    product_id TEXT,            -- supplier product id
    variant_id TEXT,            -- supplier variant id (used for cart building)
    variant_title TEXT,
    unit_price_cents INTEGER,
    quantity INTEGER NOT NULL DEFAULT 1,
    mechanism_id INTEGER REFERENCES mechanisms(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'needed', -- needed | ordered | arrived
    priority TEXT NOT NULL DEFAULT 'normal', -- low | normal | high | urgent
    requested_by TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    ordered_at TEXT,
    arrived_at TEXT
  );

  -- What the team already has on the shelf.
  CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    supplier TEXT,
    sku TEXT,
    url TEXT,
    image TEXT,
    product_id TEXT,
    variant_id TEXT,
    variant_title TEXT,
    unit_price_cents INTEGER,
    quantity INTEGER NOT NULL DEFAULT 0,
    location TEXT,
    mechanism_id INTEGER REFERENCES mechanisms(id) ON DELETE SET NULL,
    notes TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'student', -- admin | mentor | student
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_inventory_sku ON inventory(supplier, sku);
  CREATE INDEX IF NOT EXISTS idx_inventory_variant ON inventory(supplier, variant_id);
`);

// Add columns introduced after the first version, so existing databases keep working.
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumn('mechanisms', 'budget_cents', 'INTEGER');
addColumn('inventory', 'min_quantity', 'INTEGER NOT NULL DEFAULT 0');
addColumn('orders', 'created_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
addColumn('orders', 'approval', "TEXT NOT NULL DEFAULT 'approved'"); // pending | approved | rejected
addColumn('orders', 'approved_by', 'TEXT');
addColumn('orders', 'approved_at', 'TEXT');
addColumn('orders', 'rejection_reason', 'TEXT');
addColumn('orders', 'order_number', 'TEXT');
addColumn('orders', 'tracking_number', 'TEXT');
addColumn('orders', 'carrier', 'TEXT');

// Custom (made in-house) parts and the board columns they move through.
db.exec(`
  CREATE TABLE IF NOT EXISTS board_columns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#64748b',
    sort INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS custom_parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    part_number TEXT,
    cad_url TEXT,                -- Onshape (or other CAD) link
    mechanism_id INTEGER REFERENCES mechanisms(id) ON DELETE SET NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    quantity_done INTEGER NOT NULL DEFAULT 0,
    material TEXT,
    process TEXT,
    column_id INTEGER REFERENCES board_columns(id) ON DELETE SET NULL,
    sort REAL NOT NULL DEFAULT 0, -- position within its column
    priority TEXT NOT NULL DEFAULT 'normal',
    assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
    designer INTEGER REFERENCES users(id) ON DELETE SET NULL,
    due_date TEXT,
    notes TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    done_at TEXT
  );
`);

// Vendors that aren't built-in suppliers (local shops, Amazon, Misumi…). Orders store the vendor's name.
db.exec(`
  CREATE TABLE IF NOT EXISTS vendors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    website TEXT,
    color TEXT NOT NULL DEFAULT '#64748b'
  );
`);

if (db.prepare('SELECT COUNT(*) AS n FROM board_columns').get().n === 0) {
  const cols = [
    ['Design', '#8b5cf6'],
    ['Ready', '#0ea5e9'],
    ['Manufacturing', '#f59e0b'],
    ['Done', '#16a34a'],
  ];
  const ins = db.prepare('INSERT INTO board_columns (name, color, sort) VALUES (?, ?, ?)');
  cols.forEach(([name, color], i) => ins.run(name, color, i));
}

const mechCount = db.prepare('SELECT COUNT(*) AS n FROM mechanisms').get().n;
if (mechCount === 0) {
  const defaults = [
    ['Drivetrain', '#2563eb'],
    ['Intake', '#16a34a'],
    ['Shooter', '#dc2626'],
    ['Turret', '#ea580c'],
    ['Elevator', '#9333ea'],
    ['Climber', '#0891b2'],
    ['Electrical', '#ca8a04'],
    ['Spares', '#64748b'],
  ];
  const ins = db.prepare('INSERT INTO mechanisms (name, color, sort) VALUES (?, ?, ?)');
  defaults.forEach(([name, color], i) => ins.run(name, color, i));
}

// ---------------------------------------------------------------------------
// Team settings (budget, approval rules)

export const SETTING_DEFAULTS = {
  season_name: String(new Date().getFullYear() + (new Date().getMonth() >= 6 ? 1 : 0)) + ' season',
  season_budget_cents: '',
  require_approval: '0',
  approval_threshold_cents: '0', // student requests at or under this line total skip approval
  // Manufacturing processes offered on custom parts, one per line.
  processes: ['CNC router', 'Mill', 'Lathe', '3D print', 'Laser cut', 'Waterjet', 'Bandsaw / manual', 'Sheet metal bend', 'Outsourced'].join('\n'),
};

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...SETTING_DEFAULTS };
  for (const r of rows) if (r.key in SETTING_DEFAULTS) out[r.key] = r.value;
  return out;
}

export function saveSettings(values) {
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(values)) if (k in SETTING_DEFAULTS) up.run(k, v == null ? '' : String(v));
  return getSettings();
}

// Photo for custom parts (uploaded, same as part photos on orders).
addColumn('custom_parts', 'image', 'TEXT');

// Files attached to custom parts (STEP, STL, 3MF, DXF…). Stored on disk under data/files.
db.exec(`
  CREATE TABLE IF NOT EXISTS part_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    custom_part_id INTEGER REFERENCES custom_parts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,          -- original file name, shown to people
    stored_name TEXT NOT NULL,   -- random name on disk
    size INTEGER NOT NULL,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_part_files_part ON part_files(custom_part_id);
`);
