// HTTP route tests for orders, inventory and the board, against an in-memory store.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/app-harness.js';

const student = { id: 1, username: 'sam', display_name: 'Sam Student', role: 'student', password_hash: 'x' };
const otherStudent = { id: 2, username: 'pat', display_name: 'Pat Student', role: 'student', password_hash: 'x' };
const mentor = { id: 3, username: 'mo', display_name: 'Mo Mentor', role: 'mentor', password_hash: 'x' };
const users = [student, otherStudent, mentor];

const approvalOn = { require_approval: '1', approval_threshold_cents: '10000' };

function ordersCalls(h, op) {
  return h.state.calls.filter((c) => c.op === op);
}

describe('order creation', () => {
  let h;
  before(async () => {
    h = await startHarness({ storeOptions: { users, settings: approvalOn } });
  });
  after(() => h.close());

  it('lets a student create an order under the approval threshold without approval', async () => {
    const res = await h.call('POST', '/api/orders', {
      user: student, body: { name: 'Gear', unit_price_cents: 500, quantity: 2, status: 'arrived', requested_by: 'Someone Else' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.approval, 'approved');
    assert.equal(res.json.status, 'needed', 'students cannot set status on a new request');
    assert.equal(res.json.created_by, student.id);
    assert.equal(res.json.requested_by, 'Sam Student', 'students cannot set requested_by');
  });

  it('sends a student order over the threshold to pending approval', async () => {
    const res = await h.call('POST', '/api/orders', { user: student, body: { name: 'Motor', unit_price_cents: 5000, quantity: 3 } });
    assert.equal(res.json.approval, 'pending');
    assert.equal(res.json.status, 'needed');
  });

  it('sends an order with no price to pending approval when approval is required', async () => {
    const res = await h.call('POST', '/api/orders', { user: student, body: { name: 'Unknown price' } });
    assert.equal(res.json.approval, 'pending');
  });

  it('never asks a mentor for approval', async () => {
    const res = await h.call('POST', '/api/orders', { user: mentor, body: { name: 'Big motor', unit_price_cents: 999999, quantity: 9 } });
    assert.equal(res.json.approval, 'approved');
  });

  it('lets a mentor create an order already ordered and stamps the time', async () => {
    const res = await h.call('POST', '/api/orders', { user: mentor, body: { name: 'Bolt', status: 'ordered', unit_price_cents: 10, quantity: 1 } });
    assert.equal(res.json.approval, 'approved');
    const stamped = ordersCalls(h, 'updateOrder').at(-1);
    assert.equal(stamped.args[0], res.json.id);
    assert.equal(stamped.args[2], 'ordered_at = NOW');
  });

  it('turns an unknown status on create into needed', async () => {
    const res = await h.call('POST', '/api/orders', { user: mentor, body: { name: 'Nut', status: 'lost', unit_price_cents: 1, quantity: 1 } });
    assert.equal(res.json.status, 'needed');
  });

  it('returns 400 when the part has no name', async () => {
    const res = await h.call('POST', '/api/orders', { user: student, body: { description: 'no name' } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'Part name required');
  });

  it('rejects requests from people who are not signed in', async () => {
    const res = await h.call('POST', '/api/orders', { body: { name: 'x' } });
    assert.equal(res.status, 401);
  });
});

describe('order editing', () => {
  let h;
  const base = () => ({
    id: 100, name: 'Gear', created_by: student.id, status: 'needed', approval: 'approved',
    quantity: 2, unit_price_cents: 500, supplier: 'wcp', notes: null,
  });
  before(async () => {
    h = await startHarness({
      storeOptions: {
        users,
        settings: approvalOn,
        orders: [
          base(),
          { ...base(), id: 101, created_by: otherStudent.id },
          { ...base(), id: 102, status: 'ordered' },
          { ...base(), id: 103, approval: 'pending' },
          { ...base(), id: 105 },
          { ...base(), id: 106 },
          { ...base(), id: 104, approval: 'rejected', quantity: 50, unit_price_cents: 1000 },
        ],
      },
    });
  });
  after(() => h.close());

  it('blocks a student from editing someone else\'s request', async () => {
    const res = await h.call('PATCH', '/api/orders/101', { user: student, body: { notes: 'hi' } });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'You can only edit your own requests.');
  });

  it('blocks a student from editing a request that is already ordered', async () => {
    const res = await h.call('PATCH', '/api/orders/102', { user: student, body: { notes: 'hi' } });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'This part has already been ordered.');
  });

  it('ignores status changes from a student', async () => {
    const res = await h.call('PATCH', '/api/orders/100', { user: student, body: { status: 'arrived', notes: 'checking' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'needed');
    assert.equal(res.json.notes, 'checking');
  });

  it('returns 400 for an unknown status from a mentor', async () => {
    const res = await h.call('PATCH', '/api/orders/100', { user: mentor, body: { status: 'shipped' } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'Bad status');
  });

  it('will not move an unapproved request to ordered', async () => {
    const res = await h.call('PATCH', '/api/orders/103', { user: mentor, body: { status: 'ordered' } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'This request has not been approved yet.');
  });

  it('sends an approved request back for approval when a student raises the total over the threshold', async () => {
    const res = await h.call('PATCH', '/api/orders/100', { user: student, body: { quantity: 40 } });
    assert.equal(res.json.approval, 'pending');
    assert.equal(res.json.approved_by, null);
  });

  it('keeps approval when a student changes only notes', async () => {
    const res = await h.call('PATCH', '/api/orders/105', { user: student, body: { notes: 'just a note' } });
    assert.equal(res.json.approval, 'approved');
  });

  it('sends a rejected request back to pending when the student resubmits it over the threshold', async () => {
    const res = await h.call('PATCH', '/api/orders/104', { user: student, body: { notes: 'please reconsider' } });
    assert.equal(res.json.approval, 'pending');
    assert.equal(res.json.rejection_reason, null);
  });

  it('lets a mentor change any field without resetting approval', async () => {
    const res = await h.call('PATCH', '/api/orders/106', { user: mentor, body: { quantity: 40, status: 'ordered' } });
    assert.equal(res.json.approval, 'approved');
    assert.equal(res.json.quantity, 40);
  });
});

describe('bulk actions and receiving', () => {
  let h;
  before(async () => {
    h = await startHarness({
      storeOptions: {
        users,
        orders: [
          { id: 200, name: 'Gear', created_by: 1, status: 'needed', approval: 'approved', quantity: 4, unit_price_cents: 100, supplier: 'wcp' },
          { id: 201, name: 'Belt', created_by: 1, status: 'needed', approval: 'pending', quantity: 1, unit_price_cents: 100, supplier: 'wcp' },
          { id: 202, name: 'Rare', created_by: 1, status: 'needed', approval: 'approved', quantity: 1, unit_price_cents: 100, supplier: 'wcp' },
        ],
        inventory: [{ id: 9, name: 'Gear', quantity: 1, min_quantity: 5, supplier: 'wcp' }],
      },
    });
  });
  after(() => h.close());

  it('bulk status skips requests that are not approved and reports how many', async () => {
    const res = await h.call('POST', '/api/orders/bulk-status', { user: mentor, body: { ids: [200, 201], status: 'ordered', order_number: ' PO-7 ' } });
    assert.deepEqual(res.json, { ok: true, skipped: 1 });
    const updates = ordersCalls(h, 'updateOrder');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].args[0], 200);
    assert.equal(updates[0].args[1].order_number, 'PO-7', 'order number is trimmed');
  });

  it('bulk status rejects an unknown status', async () => {
    const res = await h.call('POST', '/api/orders/bulk-status', { user: mentor, body: { ids: [202], status: 'done' } });
    assert.equal(res.status, 400);
  });

  it('receiving adds to the matching inventory row and marks the order arrived', async () => {
    const res = await h.call('POST', '/api/orders/200/receive', { user: mentor, body: { quantity: 3, location: 'Shelf A' } });
    assert.equal(res.json.inventory.id, 9);
    assert.equal(res.json.order.status, 'arrived');
    const add = h.state.calls.find((c) => c.op === 'addToInventory');
    assert.equal(add.args[1], 3);
    assert.deepEqual(add.args[2], { location: 'Shelf A' });
  });

  it('receiving with no matching inventory row creates one and clamps negative quantity to 0', async () => {
    const res = await h.call('POST', '/api/orders/202/receive', { user: mentor, body: { quantity: -5 } });
    assert.equal(res.json.inventory.quantity, 0);
    const insert = h.state.calls.find((c) => c.op === 'insertInventory');
    assert.equal(insert.args[0].name, 'Rare');
    assert.equal(insert.args[0].quantity, 0);
  });

  it('reorder turns low-stock inventory into a request with the restock note', async () => {
    const res = await h.call('POST', '/api/inventory/reorder', { user: mentor, body: { items: [{ id: 9, quantity: 4 }] } });
    assert.equal(res.json.length, 1);
    assert.equal(res.json[0].quantity, 4);
    assert.equal(res.json[0].notes, 'Restock (min 5, had 4)'); // receiving added 3 to the 1 on the shelf
    assert.equal(res.json[0].approval, 'approved', 'mentors reorder without approval');
  });

  it('inventory quantity and minimum never go below zero', async () => {
    const res = await h.call('PATCH', '/api/inventory/9', { user: mentor, body: { quantity: -2, min_quantity: -1 } });
    assert.equal(res.json.quantity, 0);
    assert.equal(res.json.min_quantity, 0);
  });
});

describe('deleting requests', () => {
  let h;
  before(async () => {
    h = await startHarness({
      storeOptions: {
        users,
        orders: [
          { id: 300, name: 'Mine', created_by: 1, status: 'needed', approval: 'approved' },
          { id: 301, name: 'Ordered', created_by: 1, status: 'ordered', approval: 'approved' },
        ],
      },
    });
  });
  after(() => h.close());

  it('lets a student delete their own unordered request', async () => {
    const res = await h.call('DELETE', '/api/orders/300', { user: student });
    assert.deepEqual(res.json, { ok: true });
  });

  it('stops a student deleting a request that was already ordered', async () => {
    const res = await h.call('DELETE', '/api/orders/301', { user: student });
    assert.equal(res.status, 403);
  });
});

describe('board sorting', () => {
  let h;
  before(async () => {
    h = await startHarness({
      storeOptions: {
        users,
        columns: [{ id: 1, name: 'Todo' }, { id: 2, name: 'Doing' }],
        customParts: [
          { id: 11, name: 'A', column_id: 1, sort: 1 },
          { id: 12, name: 'B', column_id: 1, sort: 2 },
          { id: 13, name: 'C', column_id: 2, sort: 1, created_by: 1 },
        ],
      },
    });
  });
  after(() => h.close());

  it('drops a card between two others at the midpoint of their sort values', async () => {
    const res = await h.call('POST', '/api/custom-parts/13/move', { user: mentor, body: { column_id: 1, before_id: 12 } });
    assert.equal(res.json.column_id, 1);
    assert.equal(res.json.sort, 1.5);
  });

  it('drops a card at the end of a column when no card is named', async () => {
    const res = await h.call('POST', '/api/custom-parts/13/move', { user: mentor, body: { column_id: 1 } });
    assert.equal(res.json.sort, 3);
  });

  it('rejects a move to a column that does not exist', async () => {
    const res = await h.call('POST', '/api/custom-parts/13/move', { user: mentor, body: { column_id: 99 } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'Unknown column');
  });
});

describe('CSV export and carts', () => {
  let h;
  before(async () => {
    h = await startHarness({
      storeOptions: {
        users,
        mechanisms: [{ id: 7, name: 'Drive' }],
        orders: [
          { id: 400, name: 'Gear, "big"', supplier: 'wcp', quantity: 2, unit_price_cents: 1234, mechanism_id: 7, approval: 'approved', status: 'needed', variant_id: '111' },
          { id: 401, name: 'Belt', supplier: 'wcp', quantity: 1, unit_price_cents: 500, mechanism_id: 7, approval: 'approved', status: 'needed', variant_id: '111' },
          { id: 402, name: 'Unapproved', supplier: 'wcp', quantity: 1, unit_price_cents: 500, approval: 'pending', status: 'needed', variant_id: '222' },
        ],
      },
    });
  });
  after(() => h.close());

  it('exports orders as CSV with escaped names, dollar prices and the mechanism name', async () => {
    const res = await h.call('GET', '/api/orders.csv', { user: mentor });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    const [header, first] = res.text.split('\n');
    assert.ok(header.startsWith('id,status,approval,name,supplier,sku,quantity,unit_price,total,mechanism'));
    assert.ok(first.includes('"Gear, ""big"""'));
    assert.ok(first.includes(',12.34,24.68,Drive,'), first);
  });

  it('builds a Shopify cart from approved requests and merges the same variant', async () => {
    const res = await h.call('POST', '/api/cart', { user: mentor, body: { supplier: 'wcp' } });
    assert.equal(res.json.mode, 'permalink');
    assert.match(res.json.url, /\/cart\/111:3\?storefront=true$/);
    assert.deepEqual(res.json.orderIds, [400, 401]);
  });

  it('keeps unapproved requests out of the cart', async () => {
    const res = await h.call('POST', '/api/cart', { user: mentor, body: { supplier: 'wcp', orderIds: [402] } });
    assert.equal(res.json.url, null);
    assert.deepEqual(res.json.orderIds, []);
  });

  it('does not let a student build a cart', async () => {
    const res = await h.call('POST', '/api/cart', { user: student, body: { supplier: 'wcp' } });
    assert.equal(res.status, 403);
  });
});
