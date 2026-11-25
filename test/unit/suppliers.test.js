// Supplier matching, HTML/JSON parsing and cart building (server/suppliers.js). Network is stubbed.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPLIERS, supplierForSku, supplierForUrl, publicSuppliers, variantName, decode, stripTags, toCents,
  absUrl, sameSku, titleTokens, sizeValue, bigcommerceOptionCombos, swyftExtract, buildCart, fetchText, clearCache,
  search,
} from '../../server/suppliers.js';

describe('recognising a part number', () => {
  it('matches each supplier\'s part number format', () => {
    const cases = {
      'WCP-0940': 'wcp',
      'am-3402': 'andymark',
      'TTB-0347': 'ttb',
      'REV-21-1650': 'rev',
      'SR-1234': 'swyft',
      '123456': 'lastanvil',
      '91251A110': 'mcmaster',
      '300-5M-15': 'bbman',
    };
    for (const [sku, key] of Object.entries(cases)) {
      assert.equal(supplierForSku(sku)?.key, key, sku);
    }
  });

  it('returns nothing for a part number no supplier recognises, or an empty one', () => {
    assert.equal(supplierForSku('ABC'), undefined);
    assert.equal(supplierForSku(''), undefined);
    assert.equal(supplierForSku(undefined), undefined);
  });

  it('ignores surrounding spaces', () => {
    assert.equal(supplierForSku('  WCP-0940 ')?.key, 'wcp');
  });
});

describe('recognising a supplier from a link', () => {
  it('finds the supplier from the host, with or without www', () => {
    assert.equal(supplierForUrl('https://www.wcproducts.com/products/gear')?.key, 'wcp');
    assert.equal(supplierForUrl('https://wcproducts.com/')?.key, 'wcp');
    assert.equal(supplierForUrl('https://www.mcmaster.com/91251A110')?.key, 'mcmaster');
  });

  it('returns nothing for an unknown host or a bad link', () => {
    assert.equal(supplierForUrl('https://example.com/x'), undefined);
    assert.equal(supplierForUrl('not a link'), undefined);
  });
});

describe('supplier list for the browser', () => {
  it('leaves out the part number pattern and adds the cart mode and search flag', () => {
    const list = publicSuppliers();
    assert.equal(list.length, SUPPLIERS.length);
    for (const s of list) assert.equal(s.skuPattern, undefined);
    const mc = list.find((s) => s.key === 'mcmaster');
    assert.equal(mc.cartMode, 'paste');
    assert.equal(mc.searchable, false);
    assert.equal(list.find((s) => s.key === 'wcp').cartMode, 'permalink');
  });

  it('has no two suppliers that claim the same part number format', () => {
    const samples = ['WCP-1', 'am-1', 'TTB-1', 'REV-1-1', 'SR-1', '123456', '91251A110', '300-5M-15'];
    for (const sku of samples) {
      const matches = SUPPLIERS.filter((s) => s.skuPattern?.test(sku));
      assert.equal(matches.length, 1, `${sku} matches ${matches.map((s) => s.key)}`);
    }
  });
});

describe('product names', () => {
  it('uses just the product title when the variant is a default one', () => {
    assert.equal(variantName('Gear', 'Default Title'), 'Gear');
    assert.equal(variantName('Gear', 'default'), 'Gear');
    assert.equal(variantName('Gear', ''), 'Gear');
  });

  it('adds the variant after a dash otherwise', () => {
    assert.equal(variantName('Gear', '16T'), 'Gear - 16T');
  });
});

describe('text helpers', () => {
  it('decodes named, decimal and hex HTML entities and trims', () => {
    assert.equal(decode('Tom &amp; Jerry &#39;x&#39; &#x41; &nbsp;'), "Tom & Jerry 'x' A");
  });

  it('leaves an unknown entity as it was', () => {
    assert.equal(decode('a &madeup; b'), 'a &madeup; b');
  });

  it('strips tags and collapses whitespace', () => {
    assert.equal(stripTags('<p>Hello <b>world</b></p>'), 'Hello world');
  });

  it('turns line breaks into commas when stripping', () => {
    assert.equal(stripTags('one<br>two<br/>three'), 'one, two, three');
  });

  it('reads prices into cents', () => {
    assert.equal(toCents('$12.50'), 1250);
    assert.equal(toCents('1,234.5'), 123450);
    assert.equal(toCents(3), 300);
  });

  it('returns null for an empty or non-numeric price', () => {
    assert.equal(toCents(''), null);
    assert.equal(toCents(null), null);
    assert.equal(toCents('call us'), null);
  });

  it('makes relative and protocol-relative links absolute', () => {
    assert.equal(absUrl('shop.test', '//cdn.shop.test/a.png'), 'https://cdn.shop.test/a.png');
    assert.equal(absUrl('shop.test', '/p/1'), 'https://shop.test/p/1');
    assert.equal(absUrl('shop.test', 'https://other.test/x'), 'https://other.test/x');
    assert.equal(absUrl('shop.test', ''), null);
  });

  it('compares part numbers without case or surrounding spaces', () => {
    assert.equal(sameSku(' AB-1 ', 'ab-1'), true);
    assert.equal(sameSku('', 'x'), false);
    assert.equal(sameSku('AB', undefined), false);
  });

  it('splits a title into words, dropping brackets and commas', () => {
    assert.deepEqual(titleTokens('Gear (16T), 1/4"'), ['Gear', '16T', '1/4"']);
  });
});

describe('sorting sizes', () => {
  it('reads fractions, mixed numbers and plain numbers', () => {
    assert.equal(sizeValue('1/4"'), 0.25);
    assert.equal(sizeValue('1-1/2"'), 1.5);
    assert.equal(sizeValue('20t'), 20);
    assert.equal(sizeValue('2.5'), 2.5);
    assert.equal(sizeValue('none'), 0);
  });

  it('puts sizes in value order, not text order', () => {
    const labels = ['2"', '1-1/2"', '1/4"', '1"'];
    assert.deepEqual([...labels].sort((a, b) => sizeValue(a) - sizeValue(b)), ['1/4"', '1"', '1-1/2"', '2"']);
  });
});

describe('BigCommerce option parsing', () => {
  const html = [
    '<div class="form-field" data-product-attribute="set-select"><select name="attribute[422]">',
    '<option value="1691" data-product-attribute-value="1691">16T</option>',
    '<option value="1692" data-product-attribute-value="1692">20T</option>',
    '</select></div>',
    '<div class="form-field" data-product-attribute="set-rectangle"><input name="attribute[430]">',
    '<label data-product-attribute-value="2001"><span>Black</span></label>',
    '<label data-product-attribute-value="2002">Red</label>',
    '</div>',
  ].join('');

  it('expands option groups into every combination', () => {
    const combos = bigcommerceOptionCombos(html);
    assert.equal(combos.length, 4);
    assert.deepEqual(combos[0], [
      { attr: '422', value: '1691', label: '16T' },
      { attr: '430', value: '2001', label: 'Black' },
    ]);
  });

  it('stops at the limit', () => {
    assert.equal(bigcommerceOptionCombos(html, 3).length, 3);
  });

  it('returns nothing when there are no option groups', () => {
    assert.deepEqual(bigcommerceOptionCombos('<p>no options here</p>'), []);
  });
});

describe('Swyft page data', () => {
  it('reads products out of the embedded page data and maps slugs to their page paths', () => {
    const payload = '{"id":"p1","slug":"gear-16t","sku":"SR-1","name":"Gear"}';
    const html = `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script><a href="/kits/gear-16t">Gear</a>`;
    const { products, paths } = swyftExtract(html);
    assert.equal(products.length, 1);
    assert.equal(products[0].sku, 'SR-1');
    assert.equal(paths.get('gear-16t'), '/kits/gear-16t');
  });

  it('finds nothing in a page without the data', () => {
    assert.deepEqual(swyftExtract('<html></html>').products, []);
  });
});

describe('building a cart', () => {
  it('Shopify: merges the same variant into one permalink and reports skipped lines', () => {
    const cart = buildCart('wcp', [
      { orderIds: [1], name: 'A', quantity: 2, variantId: 111 },
      { orderIds: [2], name: 'B', quantity: 1, variantId: 111 },
      { orderIds: [3], name: 'C', quantity: 1, variantId: null },
      { orderIds: [4], name: 'D', quantity: 0, variantId: 222 },
    ]);
    assert.equal(cart.mode, 'permalink');
    assert.equal(cart.url, 'https://wcproducts.com/cart/111:3?storefront=true');
    assert.deepEqual(cart.skipped, [{ orderIds: [3], name: 'C' }, { orderIds: [4], name: 'D' }]);
  });

  it('Shopify: no usable lines means no URL', () => {
    assert.equal(buildCart('wcp', []).url, null);
  });

  it('McMaster: pastes upper-cased part numbers with totals, one per line', () => {
    const cart = buildCart('mcmaster', [
      { orderIds: [1], name: 'Bolt', quantity: 2, sku: '91251a110' },
      { orderIds: [2], name: 'Bolt again', quantity: 1, sku: '91251A110' },
      { orderIds: [3], name: 'No sku', quantity: 1, sku: null },
    ]);
    assert.equal(cart.mode, 'paste');
    assert.equal(cart.text, '91251A110\t3');
    assert.equal(cart.cartUrl, 'https://www.mcmaster.com/order/');
    assert.equal(cart.skipped.length, 1);
  });

  it('Swyft: one step per product link', () => {
    const cart = buildCart('swyft', [{ orderIds: [1], name: 'Kit', quantity: 2, url: 'https://swyftrobotics.com/kits/x' }]);
    assert.equal(cart.mode, 'links');
    assert.deepEqual(cart.steps, [{ orderIds: [1], name: 'Kit', quantity: 2, url: 'https://swyftrobotics.com/kits/x' }]);
  });

  it('BigCommerce: one add-to-cart link per line, with the option choices, ignoring malformed pairs', () => {
    const cart = buildCart('rev', [{ orderIds: [1], name: 'Spark', quantity: 2, productId: 55, variantId: '422=1691&430=2001&bogus' }]);
    assert.equal(cart.mode, 'sequential');
    assert.equal(
      cart.steps[0].url,
      'https://www.revrobotics.com/cart.php?action=add&product_id=55&qty=2&attribute%5B422%5D=1691&attribute%5B430%5D=2001',
    );
  });

  it('refuses a supplier it does not know', () => {
    assert.throws(() => buildCart('nobody', []), /Unknown supplier nobody/);
  });
});

describe('fetching a supplier page', () => {
  let realFetch;
  let calls;
  const stub = (responses) => {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      const next = responses.shift();
      return next;
    };
  };
  beforeEach(() => {
    realFetch = globalThis.fetch;
    calls = [];
    clearCache();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    clearCache();
  });

  it('returns the page text and reuses it from the cache', async () => {
    stub([{ status: 200, ok: true, headers: new Headers(), text: async () => 'hello' }]);
    assert.equal(await fetchText('https://cache.test/a'), 'hello');
    assert.equal(await fetchText('https://cache.test/a'), 'hello');
    assert.equal(calls.length, 1, 'second read came from the cache');
  });

  it('fetches again after the cache is cleared', async () => {
    stub([
      { status: 200, ok: true, headers: new Headers(), text: async () => 'one' },
      { status: 200, ok: true, headers: new Headers(), text: async () => 'two' },
    ]);
    assert.equal(await fetchText('https://cache.test/b'), 'one');
    clearCache();
    assert.equal(await fetchText('https://cache.test/b'), 'two');
  });

  it('throws with the HTTP status when the supplier answers with an error', async () => {
    stub([{ status: 500, ok: false, headers: new Headers(), text: async () => '' }]);
    await assert.rejects(fetchText('https://broken.test/x'), (err) => err.status === 500 && /broken\.test responded 500/.test(err.message));
  });
});

describe("searching across suppliers", () => {
  let realFetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
    clearCache();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    clearCache();
  });

  it("collects each failing supplier as an error without losing the others", async () => {
    globalThis.fetch = async () => { throw new Error("offline"); };
    const out = await search("gear", ["wcp", "rev"]);
    assert.deepEqual(out.results, []);
    assert.deepEqual(out.errors.map((e) => e.supplier).sort(), ["rev", "wcp"]);
    assert.equal(out.errors[0].message, "offline");
  });

  it("never searches McMaster, which has no search page", async () => {
    globalThis.fetch = async () => assert.fail("no request should be made");
    assert.deepEqual(await search("91251A110", ["mcmaster"]), { results: [], errors: [] });
  });

  it("ignores supplier keys it does not know", async () => {
    globalThis.fetch = async () => assert.fail("no request should be made");
    assert.deepEqual(await search("gear", ["nobody"]), { results: [], errors: [] });
  });
});
