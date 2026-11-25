// Reading and restoring backup archives (server/backup.js). Uses temp folders only; no database.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readBackup, restoreBackup } from '../../server/backup-archive.js';

// Build a minimal ustar archive from [name, data] pairs (same layout backup.js writes).
function tarOf(entries) {
  const blocks = [];
  for (const [name, data] of entries) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

describe('reading an archive', () => {
  it('lists each entry with its name and contents', () => {
    const tar = tarOf([['parts.db', Buffer.from('DB')], ['uploads/a.jpg', Buffer.from('JPEG-BYTES')]]);
    const entries = readBackup(tar);
    assert.deepEqual(entries.map((e) => e.name), ['parts.db', 'uploads/a.jpg']);
    assert.equal(entries[1].data.toString(), 'JPEG-BYTES');
  });

  it('reads contents that run past a 512-byte block boundary', () => {
    const big = Buffer.alloc(1300, 65);
    const [entry] = readBackup(tarOf([['files/big.stl', big]]));
    assert.equal(entry.data.length, 1300);
    assert.ok(entry.data.equals(big));
  });

  it('returns nothing for an empty archive', () => {
    assert.deepEqual(readBackup(Buffer.alloc(1024)), []);
  });
});

describe('restoring an archive', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parts-restore-test-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a file that has no database in it, and writes nothing', () => {
    const target = path.join(dir, 'refused');
    assert.throws(() => restoreBackup(tarOf([['uploads/a.jpg', Buffer.from('x')]]), target), /not a parts tracker backup/);
    assert.equal(fs.existsSync(path.join(target, 'uploads')), false);
  });

  it('restores the database and the photos and part files, skipping anything else', () => {
    const target = path.join(dir, 'data-1');
    const tar = tarOf([
      ['parts.db', Buffer.from('SQLITE')],
      ['uploads/0123456789abcdef0123456789abcdef.jpg', Buffer.from('photo')],
      ['files/gear.step', Buffer.from('step')],
      ['../escape.txt', Buffer.from('nope')],
      ['uploads/sub/nested.jpg', Buffer.from('nope')],
      ['other/readme.txt', Buffer.from('nope')],
    ]);
    const count = restoreBackup(tar, target);
    assert.equal(count, 3);
    assert.equal(fs.readFileSync(path.join(target, 'parts.db'), 'utf8'), 'SQLITE');
    assert.equal(fs.readFileSync(path.join(target, 'files', 'gear.step'), 'utf8'), 'step');
    assert.equal(fs.existsSync(path.join(dir, 'escape.txt')), false, 'a ../ name cannot write outside the data folder');
    assert.equal(fs.existsSync(path.join(target, 'other')), false);
    assert.equal(fs.existsSync(path.join(target, 'uploads', 'sub')), false);
  });

  it('removes the old database and its write-ahead files before restoring', () => {
    const target = path.join(dir, 'data-2');
    fs.mkdirSync(target, { recursive: true });
    for (const name of ['parts.db', 'parts.db-wal', 'parts.db-shm']) fs.writeFileSync(path.join(target, name), 'old');
    restoreBackup(tarOf([['parts.db', Buffer.from('NEW')]]), target);
    assert.equal(fs.readFileSync(path.join(target, 'parts.db'), 'utf8'), 'NEW');
    assert.equal(fs.existsSync(path.join(target, 'parts.db-wal')), false);
    assert.equal(fs.existsSync(path.join(target, 'parts.db-shm')), false);
  });
});
