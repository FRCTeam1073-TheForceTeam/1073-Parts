// Supplier integrations: product search, product/variant lookup, SKU matching and cart links.
//
// Shopify stores expose public JSON endpoints:
//   /search/suggest.json   -> product search (also matches variant SKUs)
//   /products.json         -> whole catalog (used when a store disables search)
//   /products/<handle>.js  -> full product incl. every variant (id, title, sku, price)
//   /cart/<variantId>:<qty>,<variantId>:<qty>  -> cart permalink that fills the cart
// REV runs on BigCommerce, which has no public JSON API, so we read its HTML.
// Swyft is a custom storefront; its product data is embedded in the page.
// McMaster-Carr can't be searched; parts are entered by hand and the cart is filled by pasting.

export const SUPPLIERS = [
  { key: 'wcp', name: 'WCP', domain: 'wcproducts.com', platform: 'shopify', color: '#f59e0b', skuPattern: /^WCP-\d+/i },
  { key: 'rev', name: 'REV Robotics', domain: 'www.revrobotics.com', platform: 'bigcommerce', color: '#ef4444', skuPattern: /^REV-\d/i },
  { key: 'andymark', name: 'AndyMark', domain: 'www.andymark.com', platform: 'shopify', color: '#3b82f6', skuPattern: /^am-\d+/i },
  { key: 'ttb', name: 'The Thrifty Bot', domain: 'www.thethriftybot.com', platform: 'shopify', color: '#10b981', skuPattern: /^TTB-\d+/i },
  { key: 'ctre', name: 'CTR Electronics', domain: 'store.ctr-electronics.com', platform: 'shopify', color: '#8b5cf6' },
  { key: 'redux', name: 'Redux Robotics', domain: 'shop.reduxrobotics.com', platform: 'shopify', searchMode: 'catalog', color: '#e11d48' },
  { key: 'swyft', name: 'Swyft Robotics', domain: 'swyftrobotics.com', platform: 'swyft', color: '#0ea5e9', skuPattern: /^SR-/i },
  { key: 'lastanvil', name: 'Last Anvil', domain: 'lastanvil.com', platform: 'shopify', color: '#f97316', skuPattern: /^\d{6}$/ },
  { key: 'sds', name: 'Swerve Drive Specialties', domain: 'www.swervedrivespecialties.com', platform: 'shopify', color: '#14b8a6' },
  { key: 'vbeltguys', name: 'VBeltGuys', domain: 'www.vbeltguys.com', platform: 'shopify', color: '#84cc16' },
  { key: 'bbman', name: 'B&B Manufacturing', domain: 'www.bbman.com', platform: 'bigcommerce', color: '#64748b', searchHint: 'search by part number, e.g. 300-5M-15', skuPattern: /^\d+-\d+(M|MX|GT)-?\d+/i }, // belts/pulleys: 300-5M-15, 18-5M15-6FA3
  { key: 'mcmaster', name: 'McMaster-Carr', domain: 'www.mcmaster.com', platform: 'mcmaster', color: '#a3a3a3', skuPattern: /^\d{4,5}[A-Z]\d{1,4}$/i },
];

// How each platform's "Generate cart" works, for the UI.
export const CART_MODES = { shopify: 'permalink', bigcommerce: 'sequential', swyft: 'links', mcmaster: 'paste' };
export const SEARCHABLE = (s) => s.platform !== 'mcmaster';

const byKey = Object.fromEntries(SUPPLIERS.map((s) => [s.key, s]));

export function getSupplier(key) {
  return byKey[key];
}

export function publicSuppliers() {
  return SUPPLIERS.map(({ skuPattern, ...s }) => ({ ...s, cartMode: CART_MODES[s.platform], searchable: SEARCHABLE(s) }));
}

export function supplierForUrl(url) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
  return SUPPLIERS.find((s) => s.domain.replace(/^www\./, '') === host);
}

export function supplierForSku(sku) {
  return SUPPLIERS.find((s) => s.skuPattern?.test(String(sku || '').trim()));
}

// ---------------------------------------------------------------------------
// HTTP with a small cache and polite retry (Shopify rate-limits aggressively).

const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;
const UA = 'Mozilla/5.0 (compatible; FRC1073-PartsTracker/0.2)';

async function fetchText(url, { retries = 2, cacheMs = CACHE_MS } = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < cacheMs) return hit.body;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow' });
    if (res.status === 429 && attempt < retries) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1500 * (attempt + 1);
      await new Promise((r) => setTimeout(r, Math.min(wait, 5000)));
      continue;
    }
    if (!res.ok) {
      const err = new Error(`${new URL(url).hostname} responded ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.text();
    cache.set(url, { at: Date.now(), body });
    return body;
  }
}

async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decode(str = '') {
  return str
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return String.fromCodePoint(code);
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .trim();
}

function stripTags(html = '') {
  return decode(html.replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}

function toCents(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && String(value).match(/\d/) ? Math.round(n * 100) : null;
}

function absUrl(domain, u) {
  if (!u) return null;
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('/')) return `https://${domain}${u}`;
  return u;
}

const sameSku = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// The part name that goes on an order: product title plus the chosen variant.
export function variantName(productTitle, variantTitle) {
  if (!variantTitle || /^default( title)?$/i.test(variantTitle)) return productTitle;
  return `${productTitle} - ${variantTitle}`;
}

// Loose text match used when a store has no search endpoint.
function matchesQuery(text, query) {
  const hay = text.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

// ---------------------------------------------------------------------------
// Shopify

async function shopifySearch(s, query, limit) {
  if (s.searchMode === 'catalog') return shopifyCatalogSearch(s, query, limit);
  const url =
    `https://${s.domain}/search/suggest.json?q=${encodeURIComponent(query)}` +
    `&resources[type]=product&resources[limit]=${limit}&resources[options][unavailable_products]=last` +
    `&resources[options][fields]=title,product_type,variants.title,variants.sku,vendor`;
  const data = await fetchJson(url);
  const products = data?.resources?.results?.products ?? [];
  return products.map((p) => ({
    supplier: s.key,
    handle: p.handle,
    productId: String(p.id),
    title: decode(p.title),
    url: `https://${s.domain}/products/${p.handle}`,
    image: absUrl(s.domain, p.featured_image?.url || p.image),
    priceCents: toCents(p.price_min ?? p.price),
    priceMaxCents: toCents(p.price_max),
    available: p.available,
  }));
}

async function shopifyCatalog(s) {
  const all = [];
  for (let page = 1; page <= 4; page++) {
    const data = await fetchJson(`https://${s.domain}/products.json?limit=250&page=${page}`, { cacheMs: 60 * 60 * 1000 });
    all.push(...data.products);
    if (data.products.length < 250) break;
  }
  return all;
}

async function shopifyCatalogSearch(s, query, limit) {
  const products = await shopifyCatalog(s);
  return products
    .filter((p) => matchesQuery(`${p.title} ${p.product_type} ${p.variants.map((v) => `${v.title} ${v.sku}`).join(' ')}`, query))
    .slice(0, limit)
    .map((p) => {
      const prices = p.variants.map((v) => toCents(v.price)).filter((n) => n != null);
      return {
        supplier: s.key,
        handle: p.handle,
        productId: String(p.id),
        title: decode(p.title),
        url: `https://${s.domain}/products/${p.handle}`,
        image: p.images?.[0]?.src || null,
        priceCents: prices.length ? Math.min(...prices) : null,
        priceMaxCents: prices.length ? Math.max(...prices) : null,
        available: p.variants.some((v) => v.available),
      };
    });
}

async function shopifyProduct(s, handle) {
  const p = await fetchJson(`https://${s.domain}/products/${encodeURIComponent(handle)}.js`);
  const title = decode(p.title);
  const variants = p.variants.map((v) => {
    const vTitle = decode(v.public_title || v.title);
    return {
      id: String(v.id),
      title: /^default title$/i.test(vTitle) ? null : vTitle,
      name: variantName(title, vTitle),
      sku: v.sku || null,
      priceCents: v.price, // Shopify .js prices are already in cents
      available: v.available,
      image: absUrl(s.domain, v.featured_image?.src) || absUrl(s.domain, p.featured_image),
    };
  });
  return {
    supplier: s.key,
    handle: p.handle,
    productId: String(p.id),
    title,
    description: stripTags(p.description).slice(0, 500),
    url: `https://${s.domain}/products/${p.handle}`,
    image: absUrl(s.domain, p.featured_image),
    variants,
  };
}

// ---------------------------------------------------------------------------
// BigCommerce (REV, B&B), HTML

async function bigcommerceSearch(s, query, limit) {
  const html = await fetchText(`https://${s.domain}/search.php?search_query=${encodeURIComponent(query)}&sort=relevance`);
  const results = [];
  // REV's theme: <article class="card"> ... <h3 class="card-title"><a href>Title</a>
  for (const card of html.split(/<article class="card\b/).slice(1)) {
    const link = card.match(/<h3 class="card-title">\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const href = decode(link[1]).split('?')[0];
    const sku = card.match(/card-text--sku"[^>]*>\s*([^<]+?)\s*</)?.[1];
    const price = card.match(/data-product-price-without-tax[^>]*>([^<]+)</)?.[1];
    const img = card.match(/<img[^>]+src="([^"]+)"/)?.[1];
    results.push({
      supplier: s.key,
      handle: href,
      productId: card.match(/data-product-id="(\d+)"/)?.[1] || null,
      title: stripTags(link[2]),
      sku: sku ? decode(sku) : null,
      url: href,
      image: img ? decode(img).replace('/stencil/80w/', '/stencil/320w/') : null,
      priceCents: toCents(price),
      available: true,
    });
  }

  // B&B's theme embeds each result as data: atfProductList.push({...});
  if (!results.length) {
    for (const m of html.matchAll(/atfProductList\.push\((\{[\s\S]*?\})\);/g)) {
      let p;
      try {
        p = JSON.parse(m[1]);
      } catch {
        continue;
      }
      const href = String(p.url || '').split('?')[0];
      const price = p.price?.without_tax?.value;
      results.push({
        supplier: s.key,
        handle: href,
        productId: String(p.id),
        title: decode(p.name || ''),
        sku: p.sku || null,
        url: href,
        image: typeof p.image === 'string' ? p.image : p.image?.data?.replace('{:size}', '320x320') || null,
        priceCents: price ? Math.round(price * 100) : null, // $0 means price on request
        available: true,
      });
    }
  }
  return results.slice(0, limit);
}

async function bigcommerceProduct(s, url) {
  const pageUrl = url.startsWith('http') ? url.split('?')[0] : `https://${s.domain}/${url.replace(/^\//, '')}`;
  const html = await fetchText(pageUrl);
  const meta = (prop) => html.match(new RegExp(`<meta property="og:${prop}" content="([^"]*)"`))?.[1];
  const title = decode(meta('title') || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] || '');
  const sku = html.match(/data-product-sku="([^"]+)"/)?.[1] || html.match(/data-product-sku[^>]*>\s*([^<]+?)\s*</)?.[1];
  const price = html.match(/data-product-price-without-tax[^>]*>([^<]+)</)?.[1];
  const pid = html.match(/name="product_id" value="(\d+)"/)?.[1];
  const desc = html.match(/<meta name="description" content="([^"]*)"/)?.[1];
  const image = decode(meta('image') || '') || null;

  const combos = pid ? bigcommerceOptionCombos(html) : [];
  let variants;
  if (combos.length) {
    // Each option combination is a variant. Ask the store for its real SKU and price.
    variants = await Promise.all(combos.map(async (combo) => {
      const vTitle = combo.map((c) => c.label).join(' / ');
      const info = await bigcommerceOptionInfo(s, pid, combo).catch(() => null);
      return {
        id: combo.map((c) => `${c.attr}=${c.value}`).join('&'), // attribute selection, used for the cart link
        title: vTitle,
        name: variantName(title, vTitle),
        sku: info?.sku || vTitle.match(/\((REV-[\w-]+)\)/)?.[1] || null,
        priceCents: toCents(info?.price?.without_tax?.value) ?? toCents(price),
        available: info ? info.purchasable !== false && info.instock !== false : true,
        image: info?.image?.data ? info.image.data.replace('{:size}', '320x320') : image,
      };
    }));
  } else {
    variants = [{ id: null, title: null, name: title, sku: sku ? decode(sku) : null, priceCents: toCents(price), available: true, image }];
  }

  return {
    supplier: s.key,
    handle: pageUrl,
    productId: pid || null,
    title,
    description: decode(desc || '').slice(0, 500),
    url: pageUrl,
    image,
    variants,
  };
}

// Read the product's option groups (radio buttons or dropdowns) and expand them into combinations.
function bigcommerceOptionCombos(html, max = 30) {
  const groups = [];
  const fields = html.split(/<div class="form-field" data-product-attribute="/).slice(1);
  for (const field of fields) {
    const kind = field.slice(0, field.indexOf('"'));
    const body = field.slice(0, 6000);
    const values = [];
    if (kind.startsWith('set-')) {
      if (kind === 'set-select') {
        for (const m of body.matchAll(/<option[^>]*value="(\d+)"[^>]*data-product-attribute-value="\d+"[^>]*>([^<]*)</g)) {
          values.push({ value: m[1], label: decode(m[2]) });
        }
      } else {
        for (const m of body.matchAll(/data-product-attribute-value="(\d+)"[^>]*>([\s\S]*?)<\/label>/g)) {
          values.push({ value: m[1], label: stripTags(m[2]) });
        }
      }
      const attr = body.match(/name="attribute\[(\d+)\]"/)?.[1];
      if (attr && values.length) groups.push(values.map((v) => ({ attr, ...v })));
    }
  }
  if (!groups.length) return [];
  let combos = [[]];
  for (const g of groups) {
    combos = combos.flatMap((c) => g.map((v) => [...c, v]));
    if (combos.length > max) return combos.slice(0, max);
  }
  return combos;
}

async function bigcommerceOptionInfo(s, productId, combo) {
  const key = `bc-opt:${s.key}:${productId}:${combo.map((c) => c.attr + '=' + c.value).join('&')}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;
  const form = new URLSearchParams({ action: 'add', product_id: productId, 'qty[]': '1' });
  for (const c of combo) form.append(`attribute[${c.attr}]`, c.value);
  const res = await fetch(`https://${s.domain}/remote/v1/product-attributes/${productId}`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded',
      'stencil-config': '{}',
      'stencil-options': '{}',
    },
    body: form,
  });
  if (!res.ok) throw new Error(`${s.name} option lookup ${res.status}`);
  const body = (await res.json()).data;
  cache.set(key, { at: Date.now(), body });
  return body;
}

// ---------------------------------------------------------------------------
// Swyft (custom storefront with product JSON embedded in the page)

// Pull every embedded {"id","slug","sku",...} product object out of a page.
function swyftExtract(html) {
  // The data lives in JS string literals: self.__next_f.push([1,"..."]). Decode them properly.
  const chunks = [];
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      chunks.push(JSON.parse(m[1]));
    } catch {
      // ignore malformed chunk
    }
  }
  const text = chunks.join('');
  const products = new Map();
  const re = /\{"id":"[^"]+","slug":"[^"]+","sku":/g;
  let m;
  while ((m = re.exec(text))) {
    let depth = 0;
    let end = -1;
    let inStr = false;
    for (let i = m.index; i < text.length && i < m.index + 200000; i++) {
      const ch = text[i];
      if (inStr) {
        if (ch === '\\') i++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) continue;
    try {
      const p = JSON.parse(text.slice(m.index, end + 1));
      if (!products.has(p.slug)) products.set(p.slug, p);
    } catch {
      // Not valid JSON on its own (references other chunks); skip it.
    }
  }
  // Map slugs to their real page paths (/kits/<slug>, /electrical/<slug>, ...).
  const paths = new Map();
  for (const h of html.matchAll(/href="(\/[a-z0-9-]+\/([a-z0-9-]+))"/g)) if (!paths.has(h[2])) paths.set(h[2], h[1]);
  return { products: [...products.values()], paths };
}

function swyftToProduct(s, p, paths) {
  const variants = (Array.isArray(p.variants) && p.variants.length ? p.variants : [{ label: null, priceCents: p.priceCents, sku: p.sku, shopifyVariantId: p.shopifyVariantId, availableForSale: p.availableForSale }])
    .map((v) => ({
      id: v.shopifyVariantId ? String(v.shopifyVariantId).split('/').pop() : null,
      title: v.label || null,
      name: variantName(p.name, v.label),
      sku: v.sku || null,
      priceCents: typeof v.priceCents === 'number' ? v.priceCents : null,
      available: v.availableForSale !== false,
      image: typeof v.image === 'string' ? v.image : null,
    }));
  const image = (Array.isArray(p.images) && typeof p.images[0] === 'string' && p.images[0]) || variants[0]?.image || null;
  const url = `https://${s.domain}${paths.get(p.slug) || `/products/${p.slug}`}`;
  return {
    supplier: s.key,
    handle: p.slug,
    productId: p.shopifyProductId ? String(p.shopifyProductId).split('/').pop() : p.id,
    title: p.name,
    description: typeof p.description === 'string' ? p.description.slice(0, 500) : '',
    url,
    image: image || variants.find((v) => v.image)?.image || null,
    variants: variants.map((v) => ({ ...v, image: v.image || image })),
  };
}

async function swyftCatalog(s) {
  const html = await fetchText(`https://${s.domain}/products`, { cacheMs: 60 * 60 * 1000 });
  const { products, paths } = swyftExtract(html);
  return products.map((p) => swyftToProduct(s, p, paths));
}

async function swyftSearch(s, query, limit) {
  const catalog = await swyftCatalog(s);
  return catalog
    .filter((p) => matchesQuery(`${p.title} ${p.variants.map((v) => `${v.title || ''} ${v.sku || ''}`).join(' ')}`, query))
    .slice(0, limit)
    .map((p) => {
      const prices = p.variants.map((v) => v.priceCents).filter((n) => n != null);
      return {
        supplier: s.key,
        handle: p.handle,
        productId: p.productId,
        title: p.title,
        url: p.url,
        image: p.image,
        priceCents: prices.length ? Math.min(...prices) : null,
        priceMaxCents: prices.length ? Math.max(...prices) : null,
        sku: p.variants.length === 1 ? p.variants[0].sku : null,
        available: p.variants.some((v) => v.available),
      };
    });
}

async function swyftProduct(s, handle) {
  const slug = String(handle).split('?')[0].replace(/\/$/, '').split('/').pop();
  const found = (await swyftCatalog(s)).find((p) => p.handle === slug);
  if (found) return found;
  // Not on the catalog page: read the product's own page.
  const path = String(handle).startsWith('http') ? new URL(handle).pathname : `/products/${slug}`;
  const html = await fetchText(`https://${s.domain}${path}`);
  const { products, paths } = swyftExtract(html);
  const p = products.find((x) => x.slug === slug);
  if (!p) throw new Error('Could not read that Swyft product.');
  paths.set(slug, path);
  return swyftToProduct(s, p, paths);
}

// ---------------------------------------------------------------------------
// McMaster-Carr: no product data, but the part number is in the URL.

async function mcmasterProduct(s, handle) {
  const pn = String(handle).split('?')[0].replace(/\/$/, '').split('/').pop().toUpperCase();
  return {
    supplier: s.key,
    handle: pn,
    productId: pn,
    title: '',
    description: '',
    url: `https://${s.domain}/${pn}/`,
    image: null,
    needsName: true,
    variants: [{ id: pn, title: null, name: '', sku: pn, priceCents: null, available: true, image: null }],
  };
}

// ---------------------------------------------------------------------------
// Public API

const impl = {
  shopify: { search: shopifySearch, product: shopifyProduct },
  bigcommerce: { search: bigcommerceSearch, product: bigcommerceProduct },
  swyft: { search: swyftSearch, product: swyftProduct },
  mcmaster: { search: async () => [], product: mcmasterProduct },
};

export async function search(query, supplierKeys, limit = 8) {
  const targets = (supplierKeys?.length ? supplierKeys : SUPPLIERS.map((s) => s.key))
    .map(getSupplier)
    .filter((s) => s && SEARCHABLE(s));
  const settled = await Promise.allSettled(targets.map((s) => impl[s.platform].search(s, query, limit)));
  const lists = [];
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') lists.push(r.value);
    else errors.push({ supplier: targets[i].key, message: r.reason?.message || 'failed' });
  });
  // Interleave so each supplier's best matches show near the top.
  const results = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) if (i < l.length) results.push(l[i]);
  }
  return { results, errors };
}

export async function product(supplierKey, handle) {
  const s = getSupplier(supplierKey);
  if (!s) throw new Error(`Unknown supplier ${supplierKey}`);
  return impl[s.platform].product(s, handle);
}

// Many stores (WCP especially) sell each size as its own product: "40t Spur Gear…", "60t Spur Gear…".
// Siblings are products whose names differ from this one only in tokens containing numbers.
const titleTokens = (t) => String(t).replace(/[(),]/g, ' ').split(/\s+/).filter(Boolean);

// Shopify's "related products" (what the store shows under a product) usually lists the other sizes.
async function shopifyRelated(s, productId) {
  if (!productId) return [];
  const data = await fetchJson(`https://${s.domain}/recommendations/products.json?product_id=${encodeURIComponent(productId)}&limit=10&intent=related`);
  return (data.products || []).map((p) => ({ handle: p.handle, title: decode(p.title), priceCents: typeof p.price === 'number' ? p.price : toCents(p.price) }));
}

export async function siblings(supplierKey, handle, title, productId) {
  const s = getSupplier(supplierKey);
  if (!s || !SEARCHABLE(s) || !title) return [];
  const mine = titleTokens(title);
  const numbered = mine.map((w, i) => (/\d/.test(w) ? i : -1)).filter((i) => i >= 0);
  if (!numbered.length || mine.length - numbered.length < 2) return []; // nothing size-like to vary

  // Search with one numbered token left out at a time (the size usually comes first), plus related products.
  const queries = numbered.slice(0, 2).map((skip) => mine.filter((_, i) => i !== skip).slice(0, 9).join(' '));
  const lookups = queries.map((q) => impl[s.platform].search(s, q, 10));
  if (s.platform === 'shopify') lookups.push(shopifyRelated(s, productId));
  const settled = await Promise.allSettled(lookups);
  const seen = new Set();
  const results = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).filter((r) => !seen.has(r.handle) && seen.add(r.handle));

  const found = [];
  for (const r of results) {
    if (r.handle === handle) continue;
    const theirs = titleTokens(r.title);
    if (theirs.length !== mine.length) continue;
    const positions = [];
    for (let i = 0; i < mine.length && positions.length <= 2; i++) {
      if (mine[i].toLowerCase() === theirs[i].toLowerCase()) continue;
      positions.push(/\d/.test(mine[i]) && /\d/.test(theirs[i]) ? i : -1);
    }
    if (!positions.length || positions.length > 2 || positions.includes(-1)) continue;
    found.push({ r, theirs, positions });
  }
  // Prefer products that differ in exactly one number (same gear, other tooth count); fall back to two.
  const single = found.filter((f) => f.positions.length === 1);
  const picked = single.length ? single : found;
  if (!picked.length) return [];

  const labelAt = (tokens, positions) => positions.map((i) => tokens[i]).join(' ');
  const varying = picked[0].positions;
  const out = picked.map(({ r, theirs, positions }) => ({
    handle: r.handle, title: r.title, label: labelAt(theirs, positions), priceCents: r.priceCents, sku: r.sku || null, current: false,
  }));
  out.push({ handle, title, label: labelAt(mine, varying), priceCents: null, sku: null, current: true });

  // Sort sizes by value: 1/4" < 1" < 1-1/2" < 2"; 20t < 40t.
  const size = (label) => {
    const m = String(label).match(/(\d+)(?:-(\d+)\/(\d+)|\/(\d+)|\.(\d+))?/);
    if (!m) return 0;
    if (m[2]) return Number(m[1]) + Number(m[2]) / Number(m[3]);
    if (m[4]) return Number(m[1]) / Number(m[4]);
    return parseFloat(m[0]);
  };
  return out.sort((a, b) => size(a.label) - size(b.label) || a.label.localeCompare(b.label));
}

// Look up a pasted product URL. Honors Shopify's ?variant=<id> so the chosen variant is preselected.
export async function lookupUrl(rawUrl) {
  const s = supplierForUrl(rawUrl);
  if (!s) return null;
  const u = new URL(rawUrl);
  let handle;
  if (s.platform === 'shopify') {
    handle = u.pathname.match(/\/products\/([^/?#]+)/)?.[1];
    if (!handle) throw new Error('That link does not look like a product page.');
  } else if (s.platform === 'mcmaster') {
    handle = u.pathname.split('/').filter(Boolean)[0];
    if (!handle) throw new Error('That link does not include a McMaster part number.');
  } else {
    handle = `${u.origin}${u.pathname}`;
  }
  const p = await impl[s.platform].product(s, handle);
  p.selectedVariantId = u.searchParams.get('variant') || p.variants[0]?.id || null;
  return p;
}

// Find the exact product + variant for a part number (used by BOM import).
// Returns { product, variantId } or null.
export async function matchSku(sku, { description } = {}) {
  const pn = String(sku || '').trim();
  if (!pn) return null;
  const hinted = supplierForSku(pn);
  if (hinted?.platform === 'mcmaster') {
    const p = await mcmasterProduct(hinted, pn);
    p.title = description || '';
    p.variants[0].name = description || '';
    return { product: p, variantId: p.variants[0].id };
  }
  const targets = hinted ? [hinted] : SUPPLIERS.filter((s) => SEARCHABLE(s));

  for (const s of targets) {
    let results;
    try {
      results = await impl[s.platform].search(s, pn, 4);
    } catch {
      continue;
    }
    // Results that already carry a SKU can be checked without loading the product.
    const direct = results.find((r) => sameSku(r.sku, pn));
    const candidates = direct ? [direct] : results.filter((r) => !r.sku || s.platform !== 'bigcommerce').slice(0, 3);
    for (const r of candidates) {
      try {
        const p = await impl[s.platform].product(s, r.handle);
        const v = p.variants.find((x) => sameSku(x.sku, pn));
        if (v) return { product: p, variantId: v.id };
      } catch {
        // try the next candidate
      }
    }
  }
  return null;
}

// Build what's needed to fill a supplier cart with [{variantId, productId, sku, url, quantity}].
export function buildCart(supplierKey, items) {
  const s = getSupplier(supplierKey);
  if (!s) throw new Error(`Unknown supplier ${supplierKey}`);
  const has = {
    shopify: (i) => i.variantId,
    bigcommerce: (i) => i.productId,
    swyft: (i) => i.url,
    mcmaster: (i) => i.sku,
  }[s.platform];
  const usable = items.filter((i) => has(i) && i.quantity > 0);
  const skipped = items.filter((i) => !usable.includes(i)).map((i) => ({ orderIds: i.orderIds, name: i.name }));

  if (s.platform === 'shopify') {
    // Merge duplicate variants so the permalink quantity is the total.
    const totals = new Map();
    for (const i of usable) totals.set(i.variantId, (totals.get(i.variantId) || 0) + i.quantity);
    const lines = [...totals].map(([v, q]) => `${v}:${q}`).join(',');
    return {
      mode: 'permalink',
      supplier: s.key,
      // storefront=true lands on the cart page (to review) instead of jumping straight to checkout.
      url: lines ? `https://${s.domain}/cart/${lines}?storefront=true` : null,
      skipped,
    };
  }

  if (s.platform === 'mcmaster') {
    const totals = new Map();
    for (const i of usable) totals.set(i.sku.toUpperCase(), (totals.get(i.sku.toUpperCase()) || 0) + i.quantity);
    return {
      mode: 'paste',
      supplier: s.key,
      text: [...totals].map(([pn, q]) => `${pn}\t${q}`).join('\n'),
      cartUrl: `https://${s.domain}/order/`,
      skipped,
    };
  }

  if (s.platform === 'swyft') {
    return {
      mode: 'links',
      supplier: s.key,
      steps: usable.map((i) => ({ orderIds: i.orderIds, name: i.name, quantity: i.quantity, url: i.url })),
      cartUrl: `https://${s.domain}/cart`,
      skipped,
    };
  }

  // BigCommerce adds one product per request, so the UI steps through these links.
  return {
    mode: 'sequential',
    supplier: s.key,
    steps: usable.map((i) => {
      // variantId holds the option selection, e.g. "422=1691&430=2001".
      const attrs = (i.variantId || '')
        .split('&')
        .filter((p) => /^\d+=\d+$/.test(p))
        .map((p) => {
          const [a, v] = p.split('=');
          return `&attribute%5B${a}%5D=${v}`;
        })
        .join('');
      return {
        orderIds: i.orderIds,
        name: i.name,
        quantity: i.quantity,
        url: `https://${s.domain}/cart.php?action=add&product_id=${encodeURIComponent(i.productId)}&qty=${i.quantity}${attrs}`,
      };
    }),
    cartUrl: `https://${s.domain}/cart.php`,
    skipped,
  };
}
