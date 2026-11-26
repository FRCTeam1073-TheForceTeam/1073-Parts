import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openTestDb } from './helpers/db.js';
import { makeOrder } from './helpers/fixtures.js';

// No reset() here: these tests check what the first open of a fresh database creates.
let t;
before(async () => { t = await openTestDb(); });
after(() => t.close());

const DB_MODULE = new URL('../../server/db.js', import.meta.url).href;

// Opens db.js in a separate Node process against a given data directory.
function openDbInChild(dir) {
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `await import(${JSON.stringify(DB_MODULE)})`], {
    env: { ...process.env, DATA_DIR: dir },
    stdio: 'pipe',
  });
}

test('a fresh database has every table', () => {
  const names = t.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const table of ['mechanisms', 'orders', 'inventory', 'users', 'sessions', 'settings', 'board_columns', 'custom_parts', 'vendors', 'part_files', 'part_tasks']) {
    assert.ok(names.includes(table), `missing table ${table}`);
  }
});

test('foreign keys are enforced', () => {
  assert.equal(t.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
});

test('the first open seeds 8 mechanisms and 4 board columns', () => {
  const mechanisms = t.db.prepare('SELECT COUNT(*) AS n FROM mechanisms').get().n;
  assert.equal(mechanisms, 8);
  const columns = t.db.prepare('SELECT name FROM board_columns ORDER BY sort, id').all().map((c) => c.name);
  assert.deepEqual(columns, ['Design', 'Ready', 'Manufacturing', 'Done']);
});

test('new orders get their column defaults', () => {
  const o = makeOrder(t.data);
  assert.equal(o.status, 'needed');
  assert.equal(o.priority, 'normal');
  assert.equal(o.approval, 'approved');
  assert.equal(o.quantity, 1);
  assert.equal(o.ordered_at, null);
  assert.match(o.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('re-opening an existing database does not duplicate seeded rows', () => {
  openDbInChild(t.dir);
  const mechanisms = t.db.prepare('SELECT COUNT(*) AS n FROM mechanisms').get().n;
  const columns = t.db.prepare('SELECT COUNT(*) AS n FROM board_columns').get().n;
  assert.equal(mechanisms, 8);
  assert.equal(columns, 4);
});

test('an old orders table gains the newer columns and keeps its rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parts-migrate-'));
  try {
    // A database as the first release created it: orders without the approval, created_by, or tracking columns.
    const old = new DatabaseSync(path.join(dir, 'parts.db'));
    old.exec(`CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'needed', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    old.exec("INSERT INTO orders (name, quantity) VALUES ('Legacy bearing', 3)");
    old.close();

    openDbInChild(dir);

    const migrated = new DatabaseSync(path.join(dir, 'parts.db'));
    const cols = migrated.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
    for (const col of ['created_by', 'approval', 'approved_by', 'order_number', 'tracking_number', 'carrier']) {
      assert.ok(cols.includes(col), `missing column ${col}`);
    }
    const row = migrated.prepare("SELECT name, quantity, approval FROM orders WHERE name = 'Legacy bearing'").get();
    assert.deepEqual({ ...row }, { name: 'Legacy bearing', quantity: 3, approval: 'approved' });
    migrated.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
