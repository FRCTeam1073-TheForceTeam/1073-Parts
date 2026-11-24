// Entry point. If DATA_DIR contains restore.tar (a backup from Settings → Backup or `npm run backup`),
// load it before the database opens, then rename it so it only happens once. Used to move data to a new server.
import fs from 'node:fs';
import path from 'node:path';
import { restoreBackup } from './backup.js';

const dataDir = path.resolve(process.env.DATA_DIR || 'data');
const pending = path.join(dataDir, 'restore.tar');

if (fs.existsSync(pending)) {
  const n = restoreBackup(fs.readFileSync(pending), dataDir);
  fs.renameSync(pending, path.join(dataDir, `restored-${new Date().toISOString().replace(/[:.]/g, '-')}.tar`));
  console.log(`Restored ${n} files from restore.tar`);
}

await import('./index.js');
