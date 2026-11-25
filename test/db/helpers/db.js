// Opens a throwaway database for one test file. db.js reads DATA_DIR when it is first imported,
// so DATA_DIR is set before anything is imported. node --test runs each file in its own process,
// so every test file gets its own database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Child tables first, so deleting never trips a foreign key.
const TABLES = ['part_files', 'custom_parts', 'orders', 'inventory', 'sessions', 'users', 'vendors', 'settings', 'board_columns', 'mechanisms'];

export async function openTestDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parts-test-'));
  process.env.DATA_DIR = dir;
  const { db, SETTING_DEFAULTS } = await import('../../../server/db.js');
  const data = await import('../../../server/data.js');
  return {
    db,
    data,
    dir,
    SETTING_DEFAULTS,
    // Empties every table, including the seeded mechanisms and board columns.
    reset() {
      for (const table of TABLES) db.exec(`DELETE FROM ${table}`);
    },
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
