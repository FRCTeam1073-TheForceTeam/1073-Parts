import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './helpers/db.js';
import { makeOrder, makeInventory } from './helpers/fixtures.js';

let t;
before(async () => { t = await openTestDb(); });
after(() => t.close());
beforeEach(() => t.reset());

test('createVendor stores the vendor; findVendorByName ignores case', () => {
  const v = t.data.createVendor({ name: 'Metal Co', website: 'https://metal.example', color: '#abcdef' });
  assert.equal(v.website, 'https://metal.example');
  assert.equal(t.data.findVendorByName('metal co').id, v.id);
  assert.equal(t.data.findVendorByName('Other'), undefined);
  assert.equal(t.data.countVendors(), 1);
});

test('vendor names are unique ignoring case', () => {
  t.data.createVendor({ name: 'Metal Co', color: '#000000' });
  assert.throws(() => t.data.createVendor({ name: 'METAL CO', color: '#000000' }), /UNIQUE/);
});

test('listVendors sorts by name, ignoring case', () => {
  t.data.createVendor({ name: 'bravo', color: '#000000' });
  t.data.createVendor({ name: 'Alpha', color: '#000000' });
  assert.deepEqual(t.data.listVendors().map((v) => v.name), ['Alpha', 'bravo']);
});

test('ensureVendor adds a missing vendor once and is safe to repeat', () => {
  t.data.ensureVendor('Local Shop');
  t.data.ensureVendor('Local Shop');
  assert.equal(t.data.countVendors(), 1);
});

test('updateVendor changes only the given fields', () => {
  const v = t.data.createVendor({ name: 'Metal Co', website: 'https://old.example', color: '#000000' });
  const updated = t.data.updateVendor(v.id, { website: 'https://new.example' });
  assert.equal(updated.website, 'https://new.example');
  assert.equal(updated.name, 'Metal Co');
});

test('renameVendor renames the vendor and its text on orders and inventory', () => {
  const v = t.data.createVendor({ name: 'Old Name', color: '#000000' });
  const o = makeOrder(t.data, { supplier: 'Old Name' });
  const inv = makeInventory(t.data, { supplier: 'Old Name' });
  const unrelated = makeOrder(t.data, { supplier: 'Someone Else' });
  const updated = t.data.renameVendor(v, { name: 'New Name' });
  assert.equal(updated.name, 'New Name');
  assert.equal(t.data.getOrder(o.id).supplier, 'New Name');
  assert.equal(t.data.getInventory(inv.id).supplier, 'New Name');
  assert.equal(t.data.getOrder(unrelated.id).supplier, 'Someone Else');
});

test('deleteVendor removes the vendor but keeps its name on existing orders', () => {
  const v = t.data.createVendor({ name: 'Gone Shop', color: '#000000' });
  const o = makeOrder(t.data, { supplier: 'Gone Shop' });
  t.data.deleteVendor(v.id);
  assert.equal(t.data.findVendorByName('Gone Shop'), undefined);
  assert.equal(t.data.getOrder(o.id).supplier, 'Gone Shop');
});

test('listSuppliersInUse returns distinct non-empty suppliers from orders and inventory', () => {
  makeOrder(t.data, { supplier: 'Shop A' });
  makeOrder(t.data, { supplier: 'Shop A' });
  makeOrder(t.data, { supplier: '' });
  makeOrder(t.data, {});
  makeInventory(t.data, { supplier: 'Shop B' });
  assert.deepEqual(t.data.listSuppliersInUse().map((r) => r.supplier).sort(), ['Shop A', 'Shop B']);
});
