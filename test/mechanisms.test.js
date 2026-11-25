import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './helpers/db.js';
import { makeColumn, makeMechanism, makeOrder, makeInventory, makePart } from './helpers/fixtures.js';

let t;
before(async () => { t = await openTestDb(); });
after(() => t.close());
beforeEach(() => t.reset());

test('mechanisms are numbered in the order they are created', () => {
  const a = makeMechanism(t.data, 'Drive');
  const b = makeMechanism(t.data, 'Intake');
  assert.equal(a.sort, 1);
  assert.equal(b.sort, 2);
  assert.equal(t.data.nextMechanismSort(), 3);
});

test('listMechanisms orders by sort, then name', () => {
  t.data.createMechanism({ name: 'Zeta', sort: 1 });
  t.data.createMechanism({ name: 'Alpha', sort: 1 });
  t.data.createMechanism({ name: 'Middle', sort: 0 });
  assert.deepEqual(t.data.listMechanisms().map((m) => m.name), ['Middle', 'Alpha', 'Zeta']);
});

test('mechanism names are unique', () => {
  makeMechanism(t.data, 'Lift');
  assert.throws(() => makeMechanism(t.data, 'Lift'), /UNIQUE/);
});

test('updateMechanism changes name, colour and budget', () => {
  const m = makeMechanism(t.data, 'Lift');
  const updated = t.data.updateMechanism(m.id, { name: 'Elevator', color: '#123456', budget_cents: 50000 });
  assert.equal(updated.name, 'Elevator');
  assert.equal(updated.color, '#123456');
  assert.equal(updated.budget_cents, 50000);
});

test('deleting a mechanism clears it from orders, inventory and parts', () => {
  const m = makeMechanism(t.data, 'Shooter');
  const col = makeColumn(t.data);
  const o = makeOrder(t.data, { mechanism_id: m.id });
  const inv = makeInventory(t.data, { mechanism_id: m.id });
  const part = makePart(t.data, col, { mechanism_id: m.id });
  t.data.deleteMechanism(m.id);
  assert.equal(t.data.getOrder(o.id).mechanism_id, null);
  assert.equal(t.data.getInventory(inv.id).mechanism_id, null);
  assert.equal(t.data.getCustomPart(part.id).mechanism_id, null);
});
