// Pure helpers in the browser modules: CSV/BOM import, budget totals, board due dates, carts, files and the viewer.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, guessColumns, toBomRows } from '../../public/js/import.js';
import { bucket } from '../../public/js/budget.js';
import { isOverdue, today, cotsColumnOf } from '../../public/js/board.js';
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
