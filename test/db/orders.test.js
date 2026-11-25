import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './helpers/db.js';
import { makeOrder, makeUser } from './helpers/fixtures.js';

let t;
before(async () => { t = await openTestDb(); });
after(() => t.close());
beforeEach(() => t.reset());

test('insertOrder stores every field it is given', () => {
  const u = makeUser(t.data);
  const o = makeOrder(t.data, {
    supplier: 'wcp', sku: 'WCP-0940', variant_id: 'v1', unit_price_cents: 1250, quantity: 4, priority: 'high', notes: 'rush', created_by: u.id,
  });
  const got = t.data.getOrder(o.id);
  assert.equal(got.supplier, 'wcp');
  assert.equal(got.sku, 'WCP-0940');
  assert.equal(got.variant_id, 'v1');
  assert.equal(got.unit_price_cents, 1250);
  assert.equal(got.quantity, 4);
  assert.equal(got.priority, 'high');
  assert.equal(got.notes, 'rush');
  assert.equal(got.created_by, u.id);
});

test('getOrder accepts a string id and returns undefined for a missing one', () => {
  const o = makeOrder(t.data);
  assert.equal(t.data.getOrder(String(o.id)).id, o.id);
  assert.equal(t.data.getOrder(999999), undefined);
});

test('listOrders returns newest first', () => {
  const a = makeOrder(t.data);
  const b = makeOrder(t.data);
  assert.deepEqual(t.data.listOrders().map((o) => o.id), [b.id, a.id]);
});

test('listOrdersBySupplier groups by supplier, then id', () => {
  const b1 = makeOrder(t.data, { supplier: 'b-shop' });
  const a1 = makeOrder(t.data, { supplier: 'a-shop' });
  const b2 = makeOrder(t.data, { supplier: 'b-shop' });
  assert.deepEqual(t.data.listOrdersBySupplier().map((o) => o.id), [a1.id, b1.id, b2.id]);
});

test('moving to ordered stamps ordered_at and keeps the first stamp', () => {
  const o = makeOrder(t.data);
  t.data.updateOrder(o.id, { status: 'ordered' }, t.data.statusTimestamps('ordered'));
  assert.match(t.data.getOrder(o.id).ordered_at, /^\d{4}-\d{2}-\d{2}/);
  t.db.prepare("UPDATE orders SET ordered_at = '2020-01-01 00:00:00' WHERE id = ?").run(o.id);
  t.data.updateOrder(o.id, {}, t.data.statusTimestamps('ordered'));
  assert.equal(t.data.getOrder(o.id).ordered_at, '2020-01-01 00:00:00');
});

test('arrived stamps both times, and going back to needed clears them', () => {
  const o = makeOrder(t.data);
  t.data.updateOrder(o.id, { status: 'arrived' }, t.data.statusTimestamps('arrived'));
  let got = t.data.getOrder(o.id);
  assert.ok(got.ordered_at);
  assert.ok(got.arrived_at);
  t.data.updateOrder(o.id, { status: 'needed' }, t.data.statusTimestamps('needed'));
  got = t.data.getOrder(o.id);
  assert.equal(got.ordered_at, null);
  assert.equal(got.arrived_at, null);
});

test('approval fields are updated with approved_at', () => {
  const o = makeOrder(t.data, { approval: 'pending' });
  const approved = t.data.updateOrder(o.id, { approval: 'approved', approved_by: 'Mo', rejection_reason: null }, t.data.APPROVED_NOW);
  assert.equal(approved.approval, 'approved');
  assert.equal(approved.approved_by, 'Mo');
  assert.match(approved.approved_at, /^\d{4}-\d{2}-\d{2}/);
});

test('ordersNeededFor returns only needed orders from that supplier', () => {
  const wanted = makeOrder(t.data, { supplier: 'wcp' });
  makeOrder(t.data, { supplier: 'wcp', status: 'ordered' });
  makeOrder(t.data, { supplier: 'rev' });
  assert.deepEqual(t.data.ordersNeededFor('wcp').map((o) => o.id), [wanted.id]);
});

test('ordersByIds returns exactly the orders asked for', () => {
  const a = makeOrder(t.data);
  const b = makeOrder(t.data);
  makeOrder(t.data);
  assert.deepEqual(t.data.ordersByIds([a.id, b.id]).map((o) => o.id).sort(), [a.id, b.id].sort());
});

test('deleteOrder removes the order', () => {
  const o = makeOrder(t.data);
  t.data.deleteOrder(o.id);
  assert.equal(t.data.getOrder(o.id), undefined);
});
