import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './helpers/db.js';
import { makeColumn, makePart } from './helpers/fixtures.js';

let t;
before(async () => { t = await openTestDb(); });
after(() => t.close());
beforeEach(() => t.reset());

test('columns are listed in sort order', () => {
  const first = makeColumn(t.data, 'Design');
  const second = makeColumn(t.data, 'Ready');
  assert.equal(first.sort, 1);
  assert.equal(second.sort, 2);
  assert.deepEqual(t.data.listBoardColumns().map((c) => c.name), ['Design', 'Ready']);
});

test('updateBoardColumn changes the name and colour', () => {
  const col = makeColumn(t.data, 'QA');
  const updated = t.data.updateBoardColumn(col.id, { name: 'Quality', color: '#123456' });
  assert.equal(updated.name, 'Quality');
  assert.equal(updated.color, '#123456');
});

test('deleteBoardColumn moves its cards to the fallback column and removes the column', () => {
  const doomed = makeColumn(t.data, 'Doomed');
  const fallback = makeColumn(t.data, 'Fallback');
  const p1 = makePart(t.data, doomed);
  const p2 = makePart(t.data, doomed);
  const other = makePart(t.data, fallback);
  t.data.deleteBoardColumn(doomed.id, fallback.id);
  assert.equal(t.data.getCustomPart(p1.id).column_id, fallback.id);
  assert.equal(t.data.getCustomPart(p2.id).column_id, fallback.id);
  assert.equal(t.data.getCustomPart(other.id).column_id, fallback.id);
  assert.deepEqual(t.data.listBoardColumns().map((c) => c.name), ['Fallback']);
});
