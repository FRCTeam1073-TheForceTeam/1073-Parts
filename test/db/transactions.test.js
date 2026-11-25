import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './helpers/db.js';
import { makeOrder } from './helpers/fixtures.js';

let t;
before(async () => { t = await openTestDb(); });
after(() => t.close());
beforeEach(() => t.reset());

const countOrders = () => t.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;

test('transaction keeps its writes and returns the callback result', () => {
  const result = t.data.transaction(() => {
    makeOrder(t.data, { name: 'kept' });
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(countOrders(), 1);
});

test('transaction rolls back every write when the callback throws, and rethrows', () => {
  assert.throws(() => t.data.transaction(() => {
    makeOrder(t.data, { name: 'first' });
    makeOrder(t.data, { name: 'second' });
    throw new Error('boom');
  }), /boom/);
  assert.equal(countOrders(), 0);
});

test('a rolled-back transaction leaves the connection usable for the next one', () => {
  assert.throws(() => t.data.transaction(() => { makeOrder(t.data); throw new Error('nope'); }));
  t.data.transaction(() => makeOrder(t.data, { name: 'after' }));
  assert.equal(countOrders(), 1);
});
