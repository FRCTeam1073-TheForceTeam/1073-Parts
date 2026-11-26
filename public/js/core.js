// Shared helpers, app state, modals and rendering.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// replaceChildren() that skips null/false children.
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/login') && !url.startsWith('/api/setup')) {
    onUnauthorized();
    throw new Error('Please log in again.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const money = (cents) => (cents == null || Number.isNaN(cents) ? '—' : `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const toCents = (dollars) => (dollars === '' || dollars == null ? null : Math.round(Number(dollars) * 100));
export const fromCents = (cents) => (cents == null || cents === '' ? '' : (Number(cents) / 100).toFixed(2));
export const lineTotal = (o) => (o.unit_price_cents || 0) * (o.quantity || 0);
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

let toastTimer;
export function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 5000 : 2500);
}

// Runs an async action and shows its error as a toast instead of failing silently.
export async function attempt(fn, success) {
  try {
    const out = await fn();
    if (success) toast(success);
    return out;
  } catch (err) {
    toast(err.message, true);
    return undefined;
  }
}

export const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('pt.' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('pt.' + key, JSON.stringify(value));
    } catch {
      // storage unavailable (private window); preferences just won't stick
    }
  },
};

// ---------------------------------------------------------------------------
// State

export const state = {
  view: prefs.get('view', 'board'),
  user: null,
  suppliers: [],
  mechanisms: [],
  settings: {},
  orders: [],
  inventory: [],
  users: [],
  vendors: [],
  customParts: [],
  columns: [],
  team: [],
  selected: new Set(),
  ui: {
    orderGroup: prefs.get('orderGroup', 'mechanism'),
    // Older saved tabs (open/needed/all) map to Approved.
    orderStatus: ['pending', 'approved', 'ordered', 'arrived', 'mine'].includes(prefs.get('orderStatus')) ? prefs.get('orderStatus') : 'approved',
    orderSort: prefs.get('orderSort', 'newest'),
    orderSupplier: '',
    orderMechanism: '',
    orderQuery: '',
    invGroup: prefs.get('invGroup', 'none'),
    invQuery: '',
    invLowOnly: false,
    boardMode: prefs.get('boardMode', 'custom'), // custom | cots
    boardView: prefs.get('boardView', 'board'), // board | list
    boardMech: '',
    boardPerson: '',
    boardProcess: '',
    boardSort: prefs.get('boardSort', 'board'), // board | tasks | due (order of cards within a column)
    boardQuery: '',
  },
};

export const STATUS_LABEL = { needed: 'Needed', ordered: 'Ordered', arrived: 'Arrived' };
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const ROLE_LABEL = { student: 'Student', mentor: 'Mentor', admin: 'Admin' };
const ROLE_RANK = { student: 0, mentor: 1, admin: 2 };

export const can = (role) => !!state.user && ROLE_RANK[state.user.role] >= ROLE_RANK[role];
export const isMentor = () => can('mentor');
// Students may edit their own requests until they're ordered.
export const canEditOrder = (o) => isMentor() || (o.created_by === state.user?.id && o.status === 'needed');

export const supplierByKey = (k) => state.suppliers.find((s) => s.key === k) ||
  (k ? state.suppliers.find((s) => s.custom && s.key.toLowerCase() === String(k).toLowerCase()) : undefined);
export const supplierName = (k) => supplierByKey(k)?.name || k || 'No supplier';
export const mechById = (id) => state.mechanisms.find((m) => m.id === id);
export const approvalRequired = () => state.settings.require_approval === '1';
export const personName = (id) => state.team.find((u) => u.id === id)?.display_name || null;
export const processList = () => (state.settings.processes || '').split('\n').map((p) => p.trim()).filter(Boolean);
export const initials = (name) => (name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

export function variantUrl(product, variant) {
  const s = supplierByKey(product.supplier);
  if (s?.platform === 'shopify' && product.variants.length > 1 && variant?.id) return `${product.url}?variant=${variant.id}`;
  return product.url;
}

// How many of a product the team already has on the shelf.
export function inventoryFor({ supplier, variant_id, sku, name, product_id }, { productLevel = false } = {}) {
  const lower = (s) => (s || '').toLowerCase();
  const matches = state.inventory.filter((i) => {
    if (productLevel && supplier && product_id) return i.supplier === supplier && i.product_id === String(product_id);
    if (supplier && variant_id && i.supplier === supplier && i.variant_id === String(variant_id)) return true;
    if (sku && lower(i.sku) === lower(sku)) return true;
    if (!sku && !variant_id && name && lower(i.name) === lower(name)) return true;
    return false;
  });
  return { qty: matches.reduce((n, i) => n + i.quantity, 0), items: matches };
}

export const isLowStock = (i) => i.min_quantity > 0 && i.quantity < i.min_quantity;

// Open requests already covering an inventory item (so we don't suggest reordering twice).
export function openOrdersFor(item) {
  return state.orders.filter((o) => o.status !== 'arrived' && o.approval !== 'rejected' && inventoryFor(o).items.some((x) => x.id === item.id));
}

export function stockPill(match) {
  if (!match.items.length) return null;
  const where = [...new Set(match.items.map((i) => i.location).filter(Boolean))].join(', ');
  return h('span', { class: 'pill ' + (match.qty > 0 ? 'stock-ok' : 'stock-none'), title: where ? `Location: ${where}` : 'In inventory' },
    match.qty > 0 ? `Have ${match.qty}` : 'Out of stock');
}

export function supplierPill(key) {
  const s = supplierByKey(key);
  if (!s) return key ? h('span', { class: 'pill' }, key) : '—';
  return h('span', { class: 'pill' }, h('span', { class: 'dot', style: { background: s.color } }), s.name);
}

export function mechPill(id) {
  const m = mechById(id);
  return m ? h('span', { class: 'pill' }, h('span', { class: 'dot', style: { background: m.color } }), m.name) : '—';
}

// ---------------------------------------------------------------------------
// Shipment tracking links

const CARRIERS = {
  UPS: (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`,
  FedEx: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
  USPS: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}`,
  DHL: (n) => `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${encodeURIComponent(n)}`,
};
export const CARRIER_NAMES = Object.keys(CARRIERS);

export function detectCarrier(num) {
  const n = String(num || '').replace(/\s+/g, '').toUpperCase();
  if (/^1Z[0-9A-Z]{16}$/.test(n)) return 'UPS';
  if (/^(94|93|92|95)\d{18,20}$/.test(n) || /^[A-Z]{2}\d{9}US$/.test(n)) return 'USPS';
  if (/^(\d{12}|\d{15})$/.test(n)) return 'FedEx';
  if (/^\d{10}$/.test(n)) return 'DHL';
  return null;
}

export function trackingLink(o) {
  if (!o.tracking_number) return null;
  const carrier = o.carrier || detectCarrier(o.tracking_number);
  const url = CARRIERS[carrier]?.(o.tracking_number.replace(/\s+/g, ''));
  const label = `${carrier ? carrier + ' ' : ''}${o.tracking_number}`;
  return url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, label) : label;
}

// ---------------------------------------------------------------------------
// Data loading + rendering

const views = {};
export function registerView(name, fn) {
  views[name] = fn;
}

export async function loadAll() {
  const [meta, orders, inventory, customParts] = await Promise.all([
    api('GET', '/api/meta'), api('GET', '/api/orders'), api('GET', '/api/inventory'), api('GET', '/api/custom-parts'),
  ]);
  state.user = meta.user;
  state.vendors = meta.vendors || [];
  state.suppliers = meta.suppliers.concat(state.vendors.map((v) => ({
    key: v.name, name: v.name, website: v.website, color: v.color, platform: 'manual',
    custom: true, vendorId: v.id, searchable: false, cartMode: null,
  })));
  state.mechanisms = meta.mechanisms;
  state.settings = meta.settings;
  state.orders = orders;
  state.inventory = inventory;
  state.customParts = customParts;
  state.columns = meta.columns;
  state.team = meta.team;
  state.onshapeConnected = meta.onshapeConnected;
  state.users = isMentor() ? await api('GET', '/api/users') : [];
}

export async function refresh() {
  await loadAll();
  render();
}

export function render() {
  const pending = state.orders.filter((o) => o.approval === 'pending').length;
  document.querySelectorAll('#tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.view);
    if (b.dataset.view === 'orders') {
      b.querySelector('.badge')?.remove();
      if (isMentor() && pending) b.append(h('span', { class: 'badge', title: 'Awaiting approval' }, pending));
    }
  });
  const root = document.getElementById('view');
  root.replaceChildren((views[state.view] || views.orders)());
}

export function seg(options, current, onPick) {
  return h('div', { class: 'seg' },
    options.map(([value, label]) =>
      h('button', { class: value === current ? 'active' : '', onclick: () => onPick(value) }, label)));
}

export function groupItems(items, key) {
  const groups = new Map();
  for (const it of items) {
    let gk, label, color;
    if (key === 'mechanism') {
      const m = mechById(it.mechanism_id);
      gk = m ? 'm' + m.id : 'none';
      label = m ? m.name : 'Unassigned';
      color = m?.color || '#94a3b8';
    } else if (key === 'supplier') {
      gk = it.supplier || 'none';
      label = supplierName(it.supplier);
      color = supplierByKey(it.supplier)?.color || '#94a3b8';
    } else if (key === 'status') {
      gk = it.status;
      label = STATUS_LABEL[it.status];
      color = `var(--${it.status})`;
    } else if (key === 'location') {
      gk = it.location || 'none';
      label = it.location || 'No location';
      color = '#94a3b8';
    } else {
      gk = 'all';
      label = null;
    }
    if (!groups.has(gk)) groups.set(gk, { key: gk, label, color, items: [] });
    groups.get(gk).items.push(it);
  }
  const order = key === 'mechanism' ? state.mechanisms.map((m) => 'm' + m.id) : key === 'status' ? ['needed', 'ordered', 'arrived'] : null;
  return [...groups.values()].sort((a, b) => {
    if (a.key === 'none') return 1;
    if (b.key === 'none') return -1;
    if (order) return order.indexOf(a.key) - order.indexOf(b.key);
    return String(a.label).localeCompare(String(b.label));
  });
}

// Keeps typing smooth in a filter box that triggers a re-render.
export function rerenderKeepingFocus(input) {
  const pos = input.selectionStart;
  const placeholder = input.placeholder;
  render();
  const again = [...document.querySelectorAll('#view input[type=search]')].find((i) => i.placeholder === placeholder);
  if (again) {
    again.focus();
    again.setSelectionRange(pos, pos);
  }
}

export function stat(label, value, extraClass = '') {
  return h('div', { class: `stat ${extraClass}` }, h('div', { class: 'k' }, label), h('div', { class: 'v' }, value));
}

export const field = (label, input, cls = '') => h('label', { class: `field ${cls}` }, h('span', {}, label), input);

// ---------------------------------------------------------------------------
// Modals

export function openModal(title, body, footer = [], size = '') {
  const root = document.getElementById('modal-root');
  const backdrop = h('div', { class: 'backdrop', onmousedown: (e) => e.target === backdrop && closeModal() },
    h('div', { class: `modal ${size}`, role: 'dialog', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'btn icon', onclick: closeModal, 'aria-label': 'Close' }, '✕')),
      h('div', { class: 'modal-body' }, body),
      footer.filter(Boolean).length ? h('div', { class: 'modal-foot' }, footer) : null));
  root.replaceChildren(backdrop);
  document.addEventListener('keydown', escClose);
}

function escClose(e) {
  if (e.key === 'Escape') closeModal();
}

export function closeModal() {
  document.getElementById('modal-root').replaceChildren();
  document.removeEventListener('keydown', escClose);
}

// ---------------------------------------------------------------------------
// Photos: shrink in the browser (max 1200px, JPEG) and upload. Returns the photo's URL.

export async function uploadImage(file) {
  if (!file || !/^image\//.test(file.type)) throw new Error('That file is not an image.');
  let blob = file;
  if (file.type !== 'image/gif') {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // transparent PNGs get a white background instead of black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  }
  const res = await fetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data.url;
}

// A photo box: Paste / Upload / Remove, plus drag-and-drop.
// While its dialog is open, Ctrl+V anywhere on the page pastes an image into it: a copied picture,
// a screenshot, or a copied image link (the server downloads it). getUrl/setUrl read and write the photo URL.
export function photoPicker({ getUrl, setUrl, label = 'Photo' }) {
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const box = h('div', { class: 'photo-picker' });
  let busy = false;

  async function run(status, work) {
    if (busy) return;
    busy = true;
    draw(status);
    try {
      setUrl(await work());
    } catch (err) {
      toast(err.message, true);
    }
    busy = false;
    draw();
  }
  const take = (file) => file && run('Uploading…', () => uploadImage(file));
  const takeUrl = (url) => url && run('Getting image…', async () => (await api('POST', '/api/uploads/from-url', { url })).url);

  // Pull an image (a file, an <img> in copied HTML, or an image link) out of a paste or drop.
  const isImageLink = (t) => /^https?:\/\/\S+$/i.test(t) &&
    (/\.(jpe?g|png|webp|gif)(\?|#|$)/i.test(t) || /cdn\.shopify\.com|bigcommerce\.com|\/images?\//i.test(t));
  function fromTransfer(dt, { allowPlainLink }) {
    const file = [...(dt?.files || [])].find((f) => f.type.startsWith('image/')) ||
      [...(dt?.items || [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile();
    if (file) return { file };
    const html = dt?.getData('text/html') || '';
    const src = html && new DOMParser().parseFromString(html, 'text/html').querySelector('img[src]')?.getAttribute('src');
    if (src && /^https?:/i.test(src)) return { url: src };
    const uri = (dt?.getData('text/uri-list') || '').split('\n').find((l) => l && !l.startsWith('#'))?.trim();
    if (uri && isImageLink(uri)) return { url: uri };
    const text = (dt?.getData('text/plain') || '').trim();
    if (allowPlainLink && isImageLink(text)) return { url: text };
    return null;
  }

  // "Paste image" button: reads the clipboard directly (browsers allow this on localhost and https).
  async function pasteFromClipboard() {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) return take(new File([await item.getType(type)], 'pasted', { type }));
      }
      const text = (await navigator.clipboard.readText()).trim();
      if (/^https?:\/\//i.test(text)) return takeUrl(text);
      toast('No image on the clipboard. Right-click a picture and choose "Copy image" first.', true);
    } catch {
      toast('Your browser blocked the Paste button. Press Ctrl+V (Cmd+V on Mac) instead.', true);
    }
  }

  function draw(status) {
    const url = getUrl();
    fill(box,
      url ? h('img', { src: url, alt: '' }) : h('div', { class: 'photo-empty' }, '📷'),
      h('div', { class: 'photo-actions' },
        h('div', { class: 'part-sub' }, status || (url ? label : `${label}: copy a picture anywhere and press Ctrl+V, or drop one here`)),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn small', disabled: busy, onclick: pasteFromClipboard }, 'Paste image'),
          h('button', { type: 'button', class: 'btn small', disabled: busy, onclick: () => input.click() }, url ? 'Upload another' : 'Upload file'),
          url ? h('button', { type: 'button', class: 'btn small danger', disabled: busy, onclick: () => { setUrl(null); draw(); } }, 'Remove') : null)),
      input);
  }

  input.addEventListener('change', () => {
    take(input.files[0]);
    input.value = '';
  });
  box.addEventListener('dragover', (e) => {
    e.preventDefault();
    box.classList.add('over');
  });
  box.addEventListener('dragleave', () => box.classList.remove('over'));
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('over');
    const got = fromTransfer(e.dataTransfer, { allowPlainLink: true });
    if (got?.file) take(got.file);
    else if (got?.url) takeUrl(got.url);
    else toast('Drop an image, or drag a picture from another tab.', true);
  });

  // Page-wide paste while this box is on screen. Plain text pasted into a text box is left alone;
  // a bare image link only counts when you're not typing in a field.
  // The listener removes itself once the dialog holding this box has closed.
  const onPaste = (e) => {
    if (!box.isConnected) {
      if (opened) document.removeEventListener('paste', onPaste);
      return;
    }
    const inField = e.target instanceof HTMLElement && e.target.matches('input, textarea, [contenteditable]');
    const got = fromTransfer(e.clipboardData, { allowPlainLink: !inField });
    if (!got) return;
    e.preventDefault();
    if (got.file) take(got.file);
    else takeUrl(got.url);
  };
  let opened = false; // the box is built before its dialog opens
  requestAnimationFrame(() => (opened = box.isConnected));
  document.addEventListener('paste', onPaste);

  draw();
  box.redraw = draw;
  return box;
}

// Light / dark / follow the computer. Saved per browser; index.html applies it before the page draws.
export function setTheme(t) {
  prefs.set('theme', t);
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

// How big everything is drawn: auto (scales with the screen) / small / normal / large. Same idea as the theme.
export function setSize(s) {
  prefs.set('size', s);
  if (s === 'auto') delete document.documentElement.dataset.size;
  else document.documentElement.dataset.size = s;
}
