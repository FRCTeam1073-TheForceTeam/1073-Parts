import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './helpers/db.js';
import { makeInventory } from './helpers/fixtures.js';

let t;
before(async () => { t = await openTestDb(); });
after(() => t.close());
beforeEach(() => t.reset());

test('insertInventory stores the item and getInventory returns it', () => {
  const item = makeInventory(t.data, { name: 'Spare gear', quantity: 5, min_quantity: 2, location: 'Shelf 1' });
  const got = t.data.getInventory(item.id);
  assert.equal(got.name, 'Spare gear');
  assert.equal(got.quantity, 5);
  assert.equal(got.min_quantity, 2);
  assert.equal(got.location, 'Shelf 1');
  assert.equal(t.data.getInventory(999999), undefined);
});

test('listInventory sorts by name, ignoring case', () => {
  makeInventory(t.data, { name: 'banana' });
  makeInventory(t.data, { name: 'Apple' });
  assert.deepEqual(t.data.listInventory().map((i) => i.name), ['Apple', 'banana']);
});

test('findInventoryMatch prefers supplier and variant over sku and name', () => {
  const byVariant = makeInventory(t.data, { name: 'Thing A', supplier: 'wcp', variant_id: 'v1' });
  const bySku = makeInventory(t.data, { name: 'Thing B', sku: 'WCP-0940' });
  assert.equal(t.data.findInventoryMatch({ supplier: 'wcp', variant_id: 'v1', sku: 'wcp-0940' }).id, byVariant.id);
  assert.equal(t.data.findInventoryMatch({ sku: 'wcp-0940' }).id, bySku.id);
});

test('findInventoryMatch matches sku and name ignoring case, and returns undefined when nothing matches', () => {
  const item = makeInventory(t.data, { name: 'Thing B', sku: 'WCP-0940' });
  assert.equal(t.data.findInventoryMatch({ sku: 'wcp-0940' }).id, item.id);
  assert.equal(t.data.findInventoryMatch({ name: 'thing b' }).id, item.id);
  assert.equal(t.data.findInventoryMatch({ name: 'nothing like it' }), undefined);
});

test('addToInventory adds to the count, sets extra fields and refreshes updated_at', () => {
  const item = makeInventory(t.data, { quantity: 2 });
  t.db.prepare("UPDATE inventory SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(item.id);
  const updated = t.data.addToInventory(item.id, 3, { location: 'Bin 2' });
  assert.equal(updated.quantity, 5);
  assert.equal(updated.location, 'Bin 2');
  assert.notEqual(updated.updated_at, '2020-01-01 00:00:00');
});

test('updateInventory changes only the given fields', () => {
  const item = makeInventory(t.data, { name: 'Gear', quantity: 1 });
  const updated = t.data.updateInventory(item.id, { min_quantity: 4 });
  assert.equal(updated.min_quantity, 4);
  assert.equal(updated.name, 'Gear');
  assert.equal(updated.quantity, 1);
});

test('deleteInventory removes the item', () => {
  const item = makeInventory(t.data);
  t.data.deleteInventory(item.id);
  assert.equal(t.data.getInventory(item.id), undefined);
});
