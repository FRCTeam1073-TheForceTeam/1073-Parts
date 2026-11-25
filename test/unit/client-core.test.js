// Browser-side helpers in public/js/core.js. They run in Node: core.js touches the DOM only inside functions.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  money, toCents, fromCents, lineTotal, plural, initials, detectCarrier, trackingLink, variantUrl,
  inventoryFor, isLowStock, groupItems, can, canEditOrder, processList, state,
} from '../../public/js/core.js';

// Give each test a clean slice of the shared state object, then restore it.
let saved;
beforeEach(() => {
  saved = structuredClone({ user: state.user, suppliers: state.suppliers, mechanisms: state.mechanisms, inventory: state.inventory, settings: state.settings });
});
afterEach(() => {
  Object.assign(state, saved);
});

describe('money', () => {
  it('formats cents as dollars with two decimals', () => {
    assert.match(money(12345), /\$123\.45$/);
    assert.match(money(99), /\$0\.99$/);
    assert.match(money(0), /\$0\.00$/);
  });

  it('puts the minus sign before the dollar sign for refunds and credits', () => {
    assert.match(money(-500), /^-\$5\.00$/);
  });

  it('shows an em dash when there is no amount', () => {
    assert.equal(money(null), '—');
    assert.equal(money(NaN), '—');
  });
});

describe('cents and dollars', () => {
  it('reads dollars into whole cents without floating point drift', () => {
    assert.equal(toCents('12.34'), 1234);
    assert.equal(toCents('0.29'), 29);
    assert.equal(toCents(''), null);
    assert.equal(toCents(null), null);
  });

  it('writes cents as a two-decimal dollar string', () => {
    assert.equal(fromCents(1234), '12.34');
    assert.equal(fromCents(5), '0.05');
    assert.equal(fromCents(null), '');
    assert.equal(fromCents(''), '');
  });

  it('works out a line total from the unit price and quantity', () => {
    assert.equal(lineTotal({ unit_price_cents: 250, quantity: 4 }), 1000);
    assert.equal(lineTotal({ unit_price_cents: null, quantity: 4 }), 0);
    assert.equal(lineTotal({}), 0);
  });
});

describe('text helpers', () => {
  it('adds an s for anything but exactly one', () => {
    assert.equal(plural(1, 'part'), '1 part');
    assert.equal(plural(0, 'part'), '0 parts');
    assert.equal(plural(5, 'part'), '5 parts');
  });

  it('makes initials from the first two words', () => {
    assert.equal(initials('ada lovelace'), 'AL');
    assert.equal(initials('Grace'), 'G');
    assert.equal(initials('  a  b  c '), 'AB');
    assert.equal(initials(''), '');
    assert.equal(initials(undefined), '');
  });

  it('turns the saved process list into trimmed, non-empty lines', () => {
    state.settings = { processes: 'CNC\n\n  Laser \n' };
    assert.deepEqual(processList(), ['CNC', 'Laser']);
    state.settings = {};
    assert.deepEqual(processList(), []);
  });
});

describe('shipment tracking', () => {
  it('recognises UPS, USPS, FedEx and DHL tracking numbers', () => {
    assert.equal(detectCarrier('1Z999AA10123456784'), 'UPS');
    assert.equal(detectCarrier('9400 1118 9922 3856 9312 47'), 'USPS');
    assert.equal(detectCarrier('AB123456789US'), 'USPS');
    assert.equal(detectCarrier('123456789012'), 'FedEx');
    assert.equal(detectCarrier('123456789012345'), 'FedEx');
    assert.equal(detectCarrier('1234567890'), 'DHL');
  });

  it('gives up on numbers it does not recognise', () => {
    assert.equal(detectCarrier('hello'), null);
    assert.equal(detectCarrier(''), null);
    assert.equal(detectCarrier(undefined), null);
  });

  it('shows plain text when there is no link to make', () => {
    assert.equal(trackingLink({}), null);
    assert.equal(trackingLink({ tracking_number: 'HELLO' }), 'HELLO');
  });
});

describe('variant links', () => {
  beforeEach(() => {
    state.suppliers = [{ key: 'wcp', platform: 'shopify' }, { key: 'rev', platform: 'bigcommerce' }];
  });

  it('adds the variant to a Shopify link when the product has several variants', () => {
    const product = { supplier: 'wcp', url: 'https://wcproducts.com/products/gear', variants: [{ id: 1 }, { id: 2 }] };
    assert.equal(variantUrl(product, { id: 2 }), 'https://wcproducts.com/products/gear?variant=2');
  });

  it('keeps the plain link for a single-variant product or another platform', () => {
    assert.equal(variantUrl({ supplier: 'wcp', url: 'u', variants: [{ id: 1 }] }, { id: 1 }), 'u');
    assert.equal(variantUrl({ supplier: 'rev', url: 'u', variants: [{ id: 1 }, { id: 2 }] }, { id: 2 }), 'u');
  });
});

describe('what the team has on the shelf', () => {
  beforeEach(() => {
    state.inventory = [
      { id: 1, supplier: 'wcp', variant_id: '111', sku: null, name: 'Gear', product_id: '9', quantity: 3 },
      { id: 2, supplier: 'wcp', variant_id: '111', sku: null, name: 'Gear', product_id: '9', quantity: 2 },
      { id: 3, supplier: 'other', variant_id: '111', sku: null, name: 'Other', product_id: '8', quantity: 9 },
    ];
  });

  it('adds up matching rows by supplier and variant', () => {
    const match = inventoryFor({ supplier: 'wcp', variant_id: '111', name: 'x' });
    assert.equal(match.qty, 5);
    assert.deepEqual(match.items.map((i) => i.id), [1, 2]);
  });

  it('matches by product when asked to, not just by variant', () => {
    const match = inventoryFor({ supplier: 'wcp', product_id: '9' }, { productLevel: true });
    assert.equal(match.qty, 5);
  });

  it('matches by name only when there is no supplier variant or SKU to go on', () => {
    assert.equal(inventoryFor({ name: 'gear' }).qty, 5);
    assert.equal(inventoryFor({ name: 'Nothing' }).qty, 0);
  });

  it('flags stock below its minimum, and only when a minimum is set', () => {
    assert.equal(isLowStock({ quantity: 4, min_quantity: 5 }), true);
    assert.equal(isLowStock({ quantity: 0, min_quantity: 0 }), false);
    assert.equal(isLowStock({ quantity: 6, min_quantity: 5 }), false);
  });
});

describe('grouping items', () => {
  beforeEach(() => {
    state.mechanisms = [{ id: 1, name: 'Drive', color: '#f00' }, { id: 2, name: 'Arm', color: '#0f0' }];
  });

  it('groups by mechanism in the mechanism order, with unassigned last', () => {
    const groups = groupItems([{ mechanism_id: 2 }, { mechanism_id: 1 }, { mechanism_id: null }], 'mechanism');
    assert.deepEqual(groups.map((g) => g.key), ['m1', 'm2', 'none']);
    assert.deepEqual(groups.map((g) => g.label), ['Drive', 'Arm', 'Unassigned']);
  });

  it('groups by status in the order needed, ordered, arrived', () => {
    const groups = groupItems([{ status: 'arrived' }, { status: 'needed' }, { status: 'arrived' }], 'status');
    assert.deepEqual(groups.map((g) => g.key), ['needed', 'arrived']);
    assert.equal(groups[1].items.length, 2);
  });

  it('groups by location alphabetically with no location last', () => {
    const groups = groupItems([{ location: null }, { location: 'Shelf B' }, { location: 'Bin 1' }], 'location');
    assert.deepEqual(groups.map((g) => g.label), ['Bin 1', 'Shelf B', 'No location']);
  });

  it('puts everything in one group when there is no grouping', () => {
    const groups = groupItems([{}, {}], 'none');
    assert.equal(groups.length, 1);
    assert.equal(groups[0].items.length, 2);
  });
});

describe('who may do what', () => {
  it('ranks students below mentors below admins', () => {
    state.user = { id: 5, role: 'student' };
    assert.equal(can('student'), true);
    assert.equal(can('mentor'), false);
    state.user = { id: 5, role: 'admin' };
    assert.equal(can('mentor'), true);
  });

  it('is false for everything when nobody is signed in', () => {
    state.user = null;
    assert.equal(can('student'), false);
  });

  it('lets a student edit only their own unordered requests', () => {
    state.user = { id: 5, role: 'student' };
    assert.equal(canEditOrder({ created_by: 5, status: 'needed' }), true);
    assert.equal(canEditOrder({ created_by: 5, status: 'ordered' }), false);
    assert.equal(canEditOrder({ created_by: 6, status: 'needed' }), false);
  });

  it('lets a mentor edit any request', () => {
    state.user = { id: 5, role: 'mentor' };
    assert.equal(canEditOrder({ created_by: 6, status: 'arrived' }), true);
  });
});
