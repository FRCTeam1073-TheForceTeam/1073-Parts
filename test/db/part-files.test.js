import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './helpers/db.js';
import { makeColumn, makePart, makeUser } from './helpers/fixtures.js';

let t;
before(async () => { t = await openTestDb(); });
after(() => t.close());
beforeEach(() => t.reset());

const upload = (overrides = {}) => t.data.insertPartFile({
  name: 'plate.step', stored_name: `${Math.random().toString(16).slice(2)}.step`, size: 100, uploaded_by: null, ...overrides,
});

test('insertPartFile stores the record; getPartFile returns it', () => {
  const owner = makeUser(t.data);
  const f = upload({ name: 'plate.step', size: 1234, uploaded_by: owner.id });
  const got = t.data.getPartFile(f.id);
  assert.equal(got.name, 'plate.step');
  assert.equal(got.size, 1234);
  assert.equal(got.uploaded_by, owner.id);
  assert.equal(got.custom_part_id, null);
  assert.equal(t.data.getPartFile(999999), undefined);
});

test('only the uploader can attach an unattached file, and only once', () => {
  const owner = makeUser(t.data);
  const other = makeUser(t.data);
  const part = makePart(t.data, makeColumn(t.data));
  const f = upload({ uploaded_by: owner.id });
  t.data.attachPartFile(part.id, f.id, other.id);
  assert.equal(t.data.getPartFile(f.id).custom_part_id, null);
  t.data.attachPartFile(part.id, String(f.id), owner.id);
  assert.equal(t.data.getPartFile(f.id).custom_part_id, part.id);
  const second = makePart(t.data, makeColumn(t.data));
  t.data.attachPartFile(second.id, f.id, owner.id);
  assert.equal(t.data.getPartFile(f.id).custom_part_id, part.id);
});

test('listPartFilesFor and listAttachedPartFiles only return attached files, for the right part', () => {
  const owner = makeUser(t.data);
  const column = makeColumn(t.data);
  const partA = makePart(t.data, column);
  const partB = makePart(t.data, column);
  const a1 = upload({ uploaded_by: owner.id });
  const a2 = upload({ uploaded_by: owner.id });
  const b1 = upload({ uploaded_by: owner.id });
  upload({ uploaded_by: owner.id });
  t.data.attachPartFile(partA.id, a1.id, owner.id);
  t.data.attachPartFile(partA.id, a2.id, owner.id);
  t.data.attachPartFile(partB.id, b1.id, owner.id);
  assert.deepEqual(t.data.listPartFilesFor(partA.id).map((f) => f.id), [a1.id, a2.id]);
  assert.deepEqual(t.data.listAttachedPartFiles().map((f) => f.id), [a1.id, a2.id, b1.id]);
});

test('deletePartFile removes the record', () => {
  const f = upload();
  t.data.deletePartFile(f.id);
  assert.equal(t.data.getPartFile(f.id), undefined);
});

test('takeOrphanPartFiles deletes only unattached files older than a day', () => {
  const owner = makeUser(t.data);
  const part = makePart(t.data, makeColumn(t.data));
  const oldOrphan = upload({ stored_name: 'old-orphan.step', uploaded_by: owner.id });
  const newOrphan = upload({ stored_name: 'new-orphan.step', uploaded_by: owner.id });
  const oldAttached = upload({ stored_name: 'old-attached.step', uploaded_by: owner.id });
  t.db.prepare("UPDATE part_files SET created_at = datetime('now', '-2 days') WHERE id IN (?, ?)").run(oldOrphan.id, oldAttached.id);
  t.data.attachPartFile(part.id, oldAttached.id, owner.id);

  assert.deepEqual(t.data.takeOrphanPartFiles(), ['old-orphan.step']);
  assert.equal(t.data.getPartFile(oldOrphan.id), undefined);
  assert.ok(t.data.getPartFile(newOrphan.id));
  assert.ok(t.data.getPartFile(oldAttached.id));
});
