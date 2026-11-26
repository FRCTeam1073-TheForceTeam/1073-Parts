// Pure helpers in the browser modules: CSV/BOM import, budget totals, board due dates, carts, files and the viewer.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, guessColumns, toBomRows } from '../../public/js/import.js';
import { bucket } from '../../public/js/budget.js';
import { isOverdue, today, cotsColumnOf, taskCounts, sortCards, stageOf, stageTasks, stageProgress } from '../../public/js/board.js';
import { cartable } from '../../public/js/carts.js';
import { fileSize } from '../../public/js/custom-modal.js';
import { extOf, isViewable } from '../../public/js/viewer.js';

describe('CSV parsing', () => {
  it('reads plain rows and keeps empty cells', () => {
    assert.deepEqual(parseCsv('a,b,c\n1,,3'), [['a', 'b', 'c'], ['1', '', '3']]);
  });

  it('keeps commas inside quoted cells and unescapes doubled quotes', () => {
    assert.deepEqual(parseCsv('"Gear, big","He said ""hi"""'), [['Gear, big', 'He said "hi"']]);
  });

  it('handles Windows line endings and a last line without a newline', () => {
    assert.deepEqual(parseCsv('a,b\r\nc,d'), [['a', 'b'], ['c', 'd']]);
  });

  it('treats tabs as separators, as spreadsheets paste them', () => {
    assert.deepEqual(parseCsv('a\tb'), [['a', 'b']]);
  });

  it('strips a byte-order mark from the start of the file', () => {
    assert.deepEqual(parseCsv('﻿name,qty'), [['name', 'qty']]);
  });

  it('keeps an inch mark in the middle of a cell as a plain character', () => {
    assert.deepEqual(parseCsv('1/4" plate,2'), [['1/4" plate', '2']]);
  });

  it('skips rows that are entirely blank', () => {
    assert.deepEqual(parseCsv('a\n\n   \nb'), [['a'], ['b']]);
  });
});

describe('matching CSV columns to fields', () => {
  it('finds the columns by their common header names', () => {
    const cols = guessColumns(['Part Number', 'Name', 'Description', 'Material', 'Qty']);
    assert.deepEqual(cols, { partNumber: 0, name: 1, description: 2, material: 3, quantity: 4 });
  });

  it('accepts the usual variations of the part number heading', () => {
    assert.equal(guessColumns(['SKU']).partNumber, 0);
    assert.equal(guessColumns(['Part No.']).partNumber, 0);
    assert.equal(guessColumns(['Mfr. Part #']).partNumber, 0);
  });

  it('marks a column it cannot find with -1', () => {
    assert.equal(guessColumns(['Color']).quantity, -1);
  });
});

describe('turning BOM rows into requests', () => {
  const cols = { partNumber: 0, name: 1, description: 2, material: 3, quantity: 4 };

  it('merges rows with the same part number and adds up their quantities', () => {
    const rows = [
      ['PN-1', 'Shaft', 'd', 'Steel', '2'],
      ['pn-1', 'Shaft', 'd', 'Steel', '3'],
      ['PN-2', 'Plate', '', 'Al', '1'],
    ];
    const merged = toBomRows(rows, cols);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].partNumber, 'PN-1');
    assert.equal(merged[0].qty, 5);
  });

  it('falls back to the name, then the description, to tell rows apart', () => {
    const rows = [['', 'Washer', '', '', '1'], ['', 'washer', '', '', '1'], ['', '', 'Spacer', '', '1']];
    const merged = toBomRows(rows, cols);
    assert.deepEqual(merged.map((r) => [r.name, r.qty]), [['Washer', 2], ['', 1]]);
  });

  it('counts each row as one when there is no quantity column', () => {
    const merged = toBomRows([['PN-1', 'Shaft', '', '', ''], ['PN-1', 'Shaft', '', '', '']], { ...cols, quantity: -1 });
    assert.equal(merged[0].qty, 2);
  });

  it('drops rows with nothing in them', () => {
    assert.deepEqual(toBomRows([['', '', '', '', '5']], cols), []);
  });
});

describe('budget buckets', () => {
  it('counts approved, ordered requests as spent', () => {
    const b = bucket([{ approval: 'approved', status: 'arrived', unit_price_cents: 250, quantity: 4 }]);
    assert.deepEqual(b, { spent: 1000, committed: 0, pending: 0 });
  });

  it('counts approved, not yet ordered requests as committed', () => {
    const b = bucket([{ approval: 'approved', status: 'needed', unit_price_cents: 100, quantity: 2 }]);
    assert.deepEqual(b, { spent: 0, committed: 200, pending: 0 });
  });

  it('counts requests waiting for approval as pending and ignores rejected ones', () => {
    const b = bucket([
      { approval: 'pending', status: 'needed', unit_price_cents: 300, quantity: 1 },
      { approval: 'rejected', status: 'needed', unit_price_cents: 9999, quantity: 9 },
    ]);
    assert.deepEqual(b, { spent: 0, committed: 0, pending: 300 });
  });

  it('adds nothing for an empty list', () => {
    assert.deepEqual(bucket([]), { spent: 0, committed: 0, pending: 0 });
  });
});

describe('board due dates', () => {
  it('is overdue when the due date has passed and the card is not in the last column', () => {
    assert.equal(isOverdue({ due_date: '2000-01-01', column_id: 1 }, 3), true);
  });

  it('is not overdue when it is due in the future', () => {
    assert.equal(isOverdue({ due_date: '2999-01-01', column_id: 1 }, 3), false);
  });

  it('is not overdue once the card is in the last column, or has no due date', () => {
    assert.equal(isOverdue({ due_date: '2000-01-01', column_id: 3 }, 3), false);
    assert.ok(!isOverdue({ due_date: null, column_id: 1 }, 3));
  });

  it('gives today as a YYYY-MM-DD string', () => {
    assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('COTS board columns', () => {
  it('puts a pending request in the pending column, and anything else in its status column', () => {
    assert.equal(cotsColumnOf({ approval: 'pending', status: 'needed' }), 'pending');
    assert.equal(cotsColumnOf({ approval: 'approved', status: 'ordered' }), 'ordered');
  });
});

describe('board task counts', () => {
  it('counts done and remaining tasks on a part', () => {
    assert.deepEqual(taskCounts({ tasks: [{ done: 1 }, { done: 0 }, { done: 0 }] }), { total: 3, done: 1, left: 2 });
  });

  it('treats a part without a checklist as having no tasks', () => {
    assert.deepEqual(taskCounts({}), { total: 0, done: 0, left: 0 });
  });

  it('counts a plain list of tasks too', () => {
    assert.deepEqual(taskCounts([{ done: 1 }, { done: 1 }]), { total: 2, done: 2, left: 0 });
  });
});

describe('board stages', () => {
  const columns = [{ id: 10, name: 'Design' }, { id: 11, name: 'Ready' }, { id: 12, name: 'Manufacturing' }, { id: 13, name: 'Done' }];

  it('treats a part or task with no stage as being in the first column', () => {
    assert.equal(stageOf({ column_id: null }, columns), 10);
    assert.equal(stageOf({ column_id: 12 }, columns), 12);
  });

  it('says which step of the board a part is on', () => {
    assert.deepEqual(stageProgress({ column_id: 11 }, columns), { step: 2, total: 4, name: 'Ready' });
    assert.deepEqual(stageProgress({}, columns), { step: 1, total: 4, name: 'Design' });
  });

  it('puts a part whose stage was deleted on the first step', () => {
    assert.deepEqual(stageProgress({ column_id: 99 }, columns), { step: 1, total: 4, name: 'Design' });
  });

  it('shows no steps when the board has no columns', () => {
    assert.deepEqual(stageProgress({}, []), { step: 0, total: 0, name: '' });
  });

  it('picks only the tasks for the stage the part is in now', () => {
    const part = { column_id: 11, tasks: [{ id: 1, column_id: 10 }, { id: 2, column_id: 11 }, { id: 3, column_id: 11 }, { id: 4, column_id: null }] };
    assert.deepEqual(stageTasks(part, columns).map((t) => t.id), [2, 3]);
  });

  it('can pick the tasks for another stage, counting stageless tasks as the first', () => {
    const part = { column_id: 11, tasks: [{ id: 1, column_id: 10 }, { id: 4, column_id: null }] };
    assert.deepEqual(stageTasks(part, columns, 10).map((t) => t.id), [1, 4]);
  });
});

describe('board card sorting', () => {
  const tasks = (done, left) => [...Array(done)].map(() => ({ done: 1 })).concat([...Array(left)].map(() => ({ done: 0 })));
  const ids = (list) => list.map((p) => p.id);

  it('keeps drag-and-drop order for board order', () => {
    const parts = [{ id: 1, sort: 3 }, { id: 2, sort: 1 }, { id: 3, sort: 2 }];
    assert.deepEqual(ids(sortCards(parts, 'board')), [2, 3, 1]);
  });

  it('puts the fewest unchecked tasks first and parts with no checklist last', () => {
    const parts = [
      { id: 1, sort: 1, tasks: tasks(0, 4) },
      { id: 2, sort: 2 },
      { id: 3, sort: 3, tasks: tasks(2, 1) },
      { id: 4, sort: 4, tasks: tasks(3, 0) },
    ];
    assert.deepEqual(ids(sortCards(parts, 'tasks')), [4, 3, 1, 2]);
  });

  it('sorts by the tasks left in the stage each part is in now, ignoring other stages', () => {
    const columns = [{ id: 10 }, { id: 11 }];
    const parts = [
      { id: 1, sort: 1, column_id: 11, tasks: [{ column_id: 11, done: 0 }, { column_id: 11, done: 0 }] },
      { id: 2, sort: 2, column_id: 11, tasks: [{ column_id: 10, done: 0 }, { column_id: 10, done: 0 }, { column_id: 10, done: 0 }, { column_id: 11, done: 0 }] },
    ];
    assert.deepEqual(ids(sortCards(parts, 'tasks', columns)), [2, 1]);
  });

  it('breaks a tie in tasks left by board order', () => {
    const parts = [{ id: 1, sort: 2, tasks: tasks(0, 1) }, { id: 2, sort: 1, tasks: tasks(5, 1) }];
    assert.deepEqual(ids(sortCards(parts, 'tasks')), [2, 1]);
  });

  it('puts the soonest due date first and undated parts last', () => {
    const parts = [{ id: 1, sort: 1 }, { id: 2, sort: 2, due_date: '2026-12-10' }, { id: 3, sort: 3, due_date: '2026-12-01' }];
    assert.deepEqual(ids(sortCards(parts, 'due')), [3, 2, 1]);
  });

  it('does not reorder the list it was given', () => {
    const parts = [{ id: 1, sort: 2 }, { id: 2, sort: 1 }];
    sortCards(parts, 'board');
    assert.deepEqual(ids(parts), [1, 2]);
  });
});

describe('cart eligibility', () => {
  it('needs the field each platform builds its cart from', () => {
    assert.equal(cartable({ platform: 'shopify' }, { variant_id: '1' }), true);
    assert.equal(cartable({ platform: 'shopify' }, { product_id: '1' }), false);
    assert.equal(cartable({ platform: 'bigcommerce' }, { product_id: '1' }), true);
    assert.equal(cartable({ platform: 'swyft' }, { url: 'https://x' }), true);
    assert.equal(cartable({ platform: 'mcmaster' }, { sku: '91251A110' }), true);
  });

  it('is never cartable for a platform it does not know', () => {
    assert.equal(cartable({ platform: 'mystery' }, { variant_id: '1', sku: 'x' }), false);
  });
});

describe('file sizes', () => {
  it('shows kilobytes below one megabyte, never less than 1 KB', () => {
    assert.equal(fileSize(500), '1 KB');
    assert.equal(fileSize(2048), '2 KB');
  });

  it('shows megabytes from one megabyte up', () => {
    assert.equal(fileSize(1048576), '1.0 MB');
    assert.equal(fileSize(2.5 * 1048576), '2.5 MB');
  });
});

describe('3D viewer file types', () => {
  it('reads the extension in any case', () => {
    assert.equal(extOf('bracket.STEP'), 'step');
    assert.equal(extOf('frame.v2.Stl'), 'stl');
    assert.equal(extOf(undefined), '');
  });

  it('opens the 3D model formats and nothing else', () => {
    for (const name of ['a.step', 'a.stp', 'a.stl', 'a.3mf', 'a.obj']) assert.equal(isViewable(name), true, name);
    for (const name of ['drawing.pdf', 'code.gcode', 'a.dxf', 'noext']) assert.equal(isViewable(name), false, name);
  });
});
