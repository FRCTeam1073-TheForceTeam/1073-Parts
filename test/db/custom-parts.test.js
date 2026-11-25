import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './helpers/db.js';
import { makeColumn, makePart } from './helpers/fixtures.js';

let t;
before(async () => { t = await openTestDb(); });
after(() => t.close());
beforeEach(() => t.reset());

// Board with three columns: Design (first), Ready (middle), Done (last).
function board() {
  return { design: makeColumn(t.data, 'Design'), ready: makeColumn(t.data, 'Ready'), done: makeColumn(t.data, 'Done') };
}

test('nextCardSort puts a new card at the end of its column', () => {
  const { design } = board();
  assert.equal(t.data.nextCardSort(design.id), 1);
  makePart(t.data, design);
  makePart(t.data, design);
  assert.equal(t.data.nextCardSort(design.id), 3);
});

test('cardsInColumn lists the column in board order and leaves out one card', () => {
  const { design } = board();
  const a = makePart(t.data, design);
  const b = makePart(t.data, design);
  const c = makePart(t.data, design);
  assert.deepEqual(t.data.cardsInColumn(design.id, b.id).map((c2) => c2.id), [a.id, c.id]);
});

test('listCustomParts sorts by sort, then id', () => {
  const { design, ready } = board();
  const p1 = makePart(t.data, design, { sort: 2 });
  const p2 = makePart(t.data, ready, { sort: 1 });
  const p3 = makePart(t.data, design, { sort: 2 });
  assert.deepEqual(t.data.listCustomParts().map((p) => p.id), [p2.id, p1.id, p3.id]);
});

test('columnTimestamps: leaving the first column starts the part, without marking it done', () => {
  const { design, ready } = board();
  const part = makePart(t.data, design, { quantity: 2 });
  assert.equal(t.data.columnTimestamps(design.id), 'done_at = NULL');
  t.data.updateCustomPart(part.id, { column_id: ready.id }, t.data.columnTimestamps(ready.id));
  const got = t.data.getCustomPart(part.id);
  assert.match(got.started_at, /^\d{4}-\d{2}-\d{2}/);
  assert.equal(got.done_at, null);
});

test('columnTimestamps: entering the last column marks it done and completes its quantity', () => {
  const { design, done } = board();
  const part = makePart(t.data, design, { quantity: 2, quantity_done: 0 });
  t.data.updateCustomPart(part.id, { column_id: done.id }, t.data.columnTimestamps(done.id));
  const got = t.data.getCustomPart(part.id);
  assert.match(got.done_at, /^\d{4}-\d{2}-\d{2}/);
  assert.equal(got.quantity_done, 2);
  assert.match(got.started_at, /^\d{4}-\d{2}-\d{2}/);
});

test('columnTimestamps: moving back out of the last column clears done_at but keeps started_at', () => {
  const { ready, done } = board();
  const part = makePart(t.data, done, { quantity: 1 });
  t.db.prepare("UPDATE custom_parts SET started_at = '2020-01-01 00:00:00', done_at = '2020-01-02 00:00:00' WHERE id = ?").run(part.id);
  t.data.updateCustomPart(part.id, { column_id: ready.id }, t.data.columnTimestamps(ready.id));
  const got = t.data.getCustomPart(part.id);
  assert.equal(got.done_at, null);
  assert.equal(got.started_at, '2020-01-01 00:00:00');
});

test('updateCustomPart changes only the given fields and refreshes updated_at', () => {
  const { design } = board();
  const part = makePart(t.data, design, { name: 'Plate', material: '6061' });
  t.db.prepare("UPDATE custom_parts SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(part.id);
  const updated = t.data.updateCustomPart(part.id, { quantity_done: 1 }, t.data.UPDATED_NOW);
  assert.equal(updated.quantity_done, 1);
  assert.equal(updated.name, 'Plate');
  assert.equal(updated.material, '6061');
  assert.notEqual(updated.updated_at, '2020-01-01 00:00:00');
});

test('deleteCustomPart removes the part and its file rows, and returns the stored file names', () => {
  const { design } = board();
  const part = makePart(t.data, design);
  const a = t.data.insertPartFile({ name: 'a.step', stored_name: 'aaa.step', size: 10, uploaded_by: null });
  const b = t.data.insertPartFile({ name: 'b.stl', stored_name: 'bbb.stl', size: 20, uploaded_by: null });
  t.db.prepare('UPDATE part_files SET custom_part_id = ? WHERE id IN (?, ?)').run(part.id, a.id, b.id);
  const stored = t.data.deleteCustomPart(part.id).sort();
  assert.deepEqual(stored, ['aaa.step', 'bbb.stl']);
  assert.equal(t.data.getCustomPart(part.id), undefined);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM part_files').get().n, 0);
});
