// Backups: one .tar file with a consistent copy of the database plus every photo and part file.
//
//   In the app:   Settings → Backup → Download backup (admins)
//   Make one:     node server/backup.js create backup.tar      (uses DATA_DIR, default ./data)
//   Restore one:  node server/backup.js restore backup.tar     (stop the app first; overwrites DATA_DIR)
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FOLDERS, tarEntry, restoreBackup } from './backup-archive.js';

export { readBackup, restoreBackup } from './backup-archive.js';

// Yields Buffers that together form the backup .tar.
export function* createBackup(dataDir) {
  // VACUUM INTO makes a consistent single-file copy even while the app is running.
  const tmp = path.join(os.tmpdir(), `parts-backup-${crypto.randomBytes(6).toString('hex')}.db`);
  const db = new DatabaseSync(path.join(dataDir, 'parts.db'));
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  try {
    yield* tarEntry('parts.db', fs.readFileSync(tmp));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  for (const folder of FOLDERS) {
    const dir = path.join(dataDir, folder);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isFile()) yield* tarEntry(`${folder}/${name}`, fs.readFileSync(full), st.mtimeMs);
    }
  }
  yield Buffer.alloc(1024); // end of archive
}

// Command line: create / restore.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, file] = process.argv.slice(2);
  const dataDir = path.resolve(process.env.DATA_DIR || 'data');
  if (cmd === 'create' && file) {
    const out = fs.openSync(file, 'w');
    let bytes = 0;
    for (const chunk of createBackup(dataDir)) {
      fs.writeSync(out, chunk);
      bytes += chunk.length;
    }
    fs.closeSync(out);
    console.log(`Backed up ${dataDir} to ${file} (${(bytes / 1048576).toFixed(1)} MB)`);
  } else if (cmd === 'restore' && file) {
    const n = restoreBackup(fs.readFileSync(file), dataDir);
    console.log(`Restored ${n} files into ${dataDir}`);
  } else {
    console.log('Usage: node server/backup.js create <backup.tar> | restore <backup.tar>   (DATA_DIR sets the data folder)');
    process.exitCode = 1;
  }
}
