// Pure order, board, CSV and upload rules (server/logic.js). No database or network.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pick, needsApproval, buildOrderData, buildOrderPatch, computeCardSort, ordersToCsv,
  parsePartFileName, sniffImage, isPrivateAddress, isBuiltInSupplier, HttpError,
} from '../../server/logic.js';
import { SUPPLIERS } from '../../server/suppliers.js';

const student = { id: 1, role: 'student', display_name: 'Sam Student' };
const mentor = { id: 2, role: 'mentor', display_name: 'Mo Mentor' };
const on = { require_approval: '1', approval_threshold_cents: '10000' };
const off = { require_approval: '0', approval_threshold_cents: '10000' };

describe('pick', () => {
  it('turns empty strings into null and keeps zero and false', () => {
    assert.deepEqual(pick({ a: '', b: 0, c: false, d: 'x' }, ['a', 'b', 'c']), { a: null, b: 0, c: false });
  });

  it('leaves out fields that are not in the body', () => {
    assert.deepEqual(pick({ a: 1 }, ['a', 'missing']), { a: 1 });
  });
});

describe('needsApproval', () => {
  it('never asks a mentor', () => {
    assert.equal(needsApproval(mentor, { unit_price_cents: 999999, quantity: 99 }, on), false);
  });

  it('does nothing when approval is switched off', () => {
    assert.equal(needsApproval(student, { unit_price_cents: 999999, quantity: 99 }, off), false);
  });

  it('compares the line total with the threshold', () => {
    assert.equal(needsApproval(student, { unit_price_cents: 5000, quantity: 2 }, on), false, 'exactly at the threshold is fine');
    assert.equal(needsApproval(student, { unit_price_cents: 5001, quantity: 2 }, on), true);
  });

  it('asks when the price is unknown', () => {
    assert.equal(needsApproval(student, { unit_price_cents: null, quantity: 1 }, on), true);
  });
});

describe('buildOrderData', () => {
  it('requires a part name', () => {
    assert.throws(() => buildOrderData(student, { description: 'x' }, on), (err) => err instanceof HttpError && err.status === 400 && err.message === 'Part name required');
  });

  it('ignores fields a student may not set', () => {
    const data = buildOrderData(student, { name: 'Gear', status: 'arrived', requested_by: 'Someone', approval: 'approved' }, off);
    assert.equal(data.status, undefined);
    assert.equal(data.requested_by, 'Sam Student');
  });

  it('lets a mentor set status and requested_by', () => {
    const data = buildOrderData(mentor, { name: 'Gear', status: 'ordered', requested_by: 'Pat' }, on);
    assert.equal(data.status, 'ordered');
    assert.equal(data.requested_by, 'Pat');
    assert.equal(data.approval, 'approved');
  });

  it('falls back to needed for an unknown status', () => {
    assert.equal(buildOrderData(mentor, { name: 'Gear', status: 'lost' }, off).status, 'needed');
  });

  it('marks an over-threshold student request pending and forces it to needed', () => {
    const data = buildOrderData(student, { name: 'Motor', unit_price_cents: 9000, quantity: 3 }, on);
    assert.equal(data.approval, 'pending');
    assert.equal(data.status, 'needed');
    assert.equal(data.created_by, 1);
  });
});

describe('buildOrderPatch', () => {
  const order = { id: 9, approval: 'approved', quantity: 2, unit_price_cents: 500, supplier: 'wcp', sku: 'WCP-1', notes: null, status: 'needed' };

  it('drops status from a student edit (students cannot set it)', () => {
    const data = buildOrderPatch(student, order, { status: 'arrived', notes: 'hi' }, false, off);
    assert.deepEqual(data, { notes: 'hi' });
  });

  it('rejects an unknown status', () => {
    assert.throws(() => buildOrderPatch(mentor, order, { status: 'shipped' }, true, on), /Bad status/);
  });

  it('will not move an unapproved order to ordered, unless approval is part of the same edit', () => {
    const pending = { ...order, approval: 'pending' };
    assert.throws(() => buildOrderPatch(mentor, pending, { status: 'ordered' }, true, on), /not been approved/);
    assert.equal(buildOrderPatch(mentor, pending, { status: 'ordered', approval: 'approved' }, true, on).status, 'ordered');
  });

  it('sends an approved order back for approval when a sensitive field changes over the threshold', () => {
    const data = buildOrderPatch(student, order, { quantity: 40 }, false, on);
    assert.equal(data.approval, 'pending');
    assert.equal(data.approved_by, null);
  });

  it('keeps approval when only a non-sensitive field changes', () => {
    assert.equal(buildOrderPatch(student, order, { notes: 'x' }, false, on).approval, undefined);
  });

  it('does not reset approval when a sensitive field changes to the same value', () => {
    assert.equal(buildOrderPatch(student, order, { quantity: 2 }, false, on).approval, undefined);
  });

  it('lets a mentor change sensitive fields without re-approval', () => {
    assert.equal(buildOrderPatch(mentor, order, { quantity: 40 }, true, on).approval, undefined);
  });
});

describe('computeCardSort', () => {
  const cards = [{ id: 1, sort: 1 }, { id: 2, sort: 2 }, { id: 3, sort: 4 }];

  it('puts a card at the end of an empty column at 1', () => {
    assert.equal(computeCardSort([], null), 1);
  });

  it('appends after the last card when no card is named', () => {
    assert.equal(computeCardSort(cards, undefined), 5);
  });

  it('appends when the named card is not in the column', () => {
    assert.equal(computeCardSort(cards, 99), 5);
  });

  it('puts a card in front of the first card at first minus one', () => {
    assert.equal(computeCardSort(cards, 1), 0);
  });

  it('puts a card between two cards at their midpoint', () => {
    assert.equal(computeCardSort(cards, '3'), 3);
  });
});

describe('ordersToCsv', () => {
  const mechs = { 7: 'Drive' };

  it('writes a header row and one row per order', () => {
    const csv = ordersToCsv([], mechs);
    assert.equal(csv.split('\n').length, 1);
    assert.ok(csv.startsWith('id,status,approval,name,supplier,sku,quantity,unit_price,total,mechanism,'));
  });

  it('formats cents as dollars and works out the total', () => {
    const [, row] = ordersToCsv([{ id: 1, name: 'Gear', quantity: 3, unit_price_cents: 1050, mechanism_id: 7 }], mechs).split('\n');
    const cells = row.split(',');
    assert.equal(cells[7], '10.50', 'unit price');
    assert.equal(cells[8], '31.50', 'total');
    assert.equal(cells[9], 'Drive', 'mechanism name');
  });

  it('leaves price and total empty when the price is unknown', () => {
    const [, row] = ordersToCsv([{ id: 1, name: 'Gear', quantity: 3, unit_price_cents: null }], mechs).split('\n');
    assert.equal(row.split(',').slice(7, 9).join('|'), '|');
  });

  it('quotes cells with commas, quotes or newlines and doubles embedded quotes', () => {
    const [, row] = ordersToCsv([{ id: 1, name: 'Bolt, "hex"\nlong', quantity: 1 }], {}).split('\n');
    assert.ok(row.includes('"Bolt, ""hex""'), row);
  });
});

describe('parsePartFileName', () => {
  it('accepts allowed extensions in any case and keeps only the base name', () => {
    assert.deepEqual(parsePartFileName('../../etc/bracket.STEP'), { name: 'bracket.STEP', ext: 'step' });
  });

  it('removes control characters and double quotes', () => {
    assert.equal(parsePartFileName('a"b\u0001c.pdf').name, 'abc.pdf');
  });

  it('rejects disallowed or missing extensions and empty names', () => {
    assert.equal(parsePartFileName('payload.exe'), null);
    assert.equal(parsePartFileName('noextension'), null);
    assert.equal(parsePartFileName(''), null);
    assert.equal(parsePartFileName(undefined), null);
  });

  it('caps the name at 200 characters, which can cut the extension off', () => {
    assert.ok(parsePartFileName('a'.repeat(195) + '.stl'), 'a 199-character name is fine');
    assert.equal(parsePartFileName('a'.repeat(300) + '.stl'), null);
  });
});

describe('sniffImage', () => {
  const pad = (bytes) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(16)]);

  it('recognises JPEG, PNG, GIF and WebP by their first bytes', () => {
    assert.equal(sniffImage(pad([0xff, 0xd8, 0xff])).ext, 'jpg');
    assert.equal(sniffImage(pad([0x89, 0x50, 0x4e, 0x47])).ext, 'png');
    assert.equal(sniffImage(pad(Buffer.from('GIF89a'))).ext, 'gif');
    assert.equal(sniffImage(pad(Buffer.from('RIFF\0\0\0\0WEBP'))).ext, 'webp');
  });

  it('returns null for short, non-buffer or unrecognised data', () => {
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8])), null, 'too short');
    assert.equal(sniffImage('not a buffer'), null);
    assert.equal(sniffImage(Buffer.alloc(32)), null, 'zeros are not an image');
  });
});

describe('isPrivateAddress', () => {
  it('flags loopback, private, link-local and shared IPv4 ranges', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '0.0.0.0', '169.254.9.9', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '224.0.0.1']) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
  });

  it('lets public IPv4 addresses through, including the edges of the private ranges', () => {
    for (const ip of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '192.169.0.1', '1.1.1.1']) {
      assert.equal(isPrivateAddress(ip), false, ip);
    }
  });

  it('flags private IPv6 addresses and IPv4-mapped private addresses', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'FE80::1', '::ffff:10.0.0.5', '::FFFF:127.0.0.1']) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
  });

  it('lets a public IPv6 address through', () => {
    assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
    assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false);
  });
});

describe('isBuiltInSupplier', () => {
  it('matches a built-in supplier by key or display name, ignoring case', () => {
    assert.equal(isBuiltInSupplier('WCP', SUPPLIERS), true);
    assert.equal(isBuiltInSupplier('rev robotics', SUPPLIERS), true);
    assert.equal(isBuiltInSupplier('McMaster-Carr', SUPPLIERS), true);
  });

  it('treats any other name as a vendor', () => {
    assert.equal(isBuiltInSupplier('Acme Robotics', SUPPLIERS), false);
    assert.equal(isBuiltInSupplier('WCP Extra', SUPPLIERS), false);
  });
});
