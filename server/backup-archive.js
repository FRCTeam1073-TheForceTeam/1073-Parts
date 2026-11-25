// Backup archive format: a minimal ustar .tar reader/writer and the restore step.
// No database here, so unit tests can use it. The database snapshot lives in backup.js.
import fs from 'node:fs';
import path from 'node:path';

export const FOLDERS = ['uploads', 'files'];

// --- minimal tar (ustar) writer/reader; names here are short (e.g. uploads/<32 hex>.jpg) ---

export function tarHeader(name, size, mtime) {
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

export function* tarEntry(name, data, mtime = Date.now()) {
  yield tarHeader(name, data.length, mtime);
  yield data;
  const pad = (512 - (data.length % 512)) % 512;
  if (pad) yield Buffer.alloc(pad);
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
