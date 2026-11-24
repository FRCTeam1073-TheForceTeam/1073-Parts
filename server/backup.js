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

const FOLDERS = ['uploads', 'files'];

// --- minimal tar (ustar) writer/reader; names here are short (e.g. uploads/<32 hex>.jpg) ---

function tarHeader(name, size, mtime) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write(Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0', 136);
  h.write('        ', 148); // checksum placeholder (spaces)
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

function* tarEntry(name, data, mtime = Date.now()) {
  yield tarHeader(name, data.length, mtime);
  yield data;
  const pad = (512 - (data.length % 512)) % 512;
  if (pad) yield Buffer.alloc(pad);
}

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

export function readBackup(buf) {
  const entries = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    const size = parseInt(h.toString('ascii', 124, 136).replace(/\0.*$/s, '').trim(), 8) || 0;
    off += 512;
    entries.push({ name, data: buf.subarray(off, off + size) });
    off += Math.ceil(size / 512) * 512;
  }
  return entries;
}

// Only parts.db and files directly inside uploads/ or files/ are accepted (no paths escaping DATA_DIR).
export function restoreBackup(buf, dataDir) {
  const entries = readBackup(buf);
  const valid = (n) => n === 'parts.db' || FOLDERS.some((f) => new RegExp(`^${f}/[\\w.-]+$`).test(n));
  if (!entries.some((e) => e.name === 'parts.db')) throw new Error('This file is not a parts tracker backup (no parts.db inside).');
  fs.mkdirSync(dataDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(dataDir, `parts.db${suffix}`), { force: true });
  let count = 0;
  for (const e of entries) {
    if (!valid(e.name)) continue;
    const target = path.join(dataDir, e.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.data);
    count++;
  }
  return count;
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
