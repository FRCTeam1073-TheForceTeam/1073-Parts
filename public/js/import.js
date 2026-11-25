// Import an Onshape BOM (or any CSV with part numbers) and turn it into part requests.
import {
  h, fill, api, money, plural, toast, state, supplierByKey, supplierName, inventoryFor,
  openModal, closeModal, refresh, field,
} from './core.js';

// Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF).
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true; // a quote mid-field (1/4" plate) is just an inch mark
    else if (c === ',' || c === '\t') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const COLUMN_GUESS = {
  partNumber: /^(part\s*(number|no\.?|#)|pn|sku|vendor\s*part|mfr\.?\s*part)/i,
  quantity: /^(qty|quantity|count)$/i,
  name: /^(name|part\s*name|item\s*name)$/i,
  description: /^description$/i,
  material: /^material$/i,
};

export function guessColumns(header) {
  const out = {};
  for (const [key, re] of Object.entries(COLUMN_GUESS)) {
    const idx = header.findIndex((c) => re.test(c.trim()));
    out[key] = idx;
  }
  return out;
}

// Combine duplicate rows (same part number, or same name when there's none) and sum quantities.
export function toBomRows(rows, cols) {
  const merged = new Map();
  for (const r of rows) {
    const partNumber = (r[cols.partNumber] || '').trim();
    const name = (r[cols.name] || '').trim();
    const description = (r[cols.description] || '').trim();
    const material = (r[cols.material] || '').trim();
    const qty = Math.max(0, Math.round(Number(String(r[cols.quantity] ?? '1').replace(/[^0-9.]/g, '')) || 0)) || (cols.quantity < 0 ? 1 : 0);
    if (!partNumber && !name && !description) continue;
    const key = (partNumber || name || description).toLowerCase();
    const prev = merged.get(key);
    if (prev) prev.qty += qty;
    else merged.set(key, { partNumber, name, description, material, qty });
  }
  return [...merged.values()];
}

export function openImportModal() {
  const fileInput = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv' });
  const paste = h('textarea', { rows: 6, placeholder: 'Or paste CSV here (first row = column names)', class: 'mono' });
  const mech = h('select', {}, h('option', { value: '' }, 'Unassigned'), state.mechanisms.map((m) => h('option', { value: m.id }, m.name)));
  const subtract = h('input', { type: 'checkbox', checked: true });
  const area = h('div', { class: 'import-area' });
  const footerTotal = h('span', { class: 'note grow' });
  const importBtn = h('button', { class: 'btn primary', disabled: true }, 'Import');
  let items = [];

  const onshapeUrl = h('input', { type: 'url', placeholder: 'https://cad.onshape.com/documents/…/e/…' });
  const onshapeBtn = h('button', { class: 'btn primary', onclick: () => loadOnshape() }, 'Load from Onshape');
  onshapeUrl.addEventListener('keydown', (e) => e.key === 'Enter' && loadOnshape());

  async function loadOnshape() {
    const url = onshapeUrl.value.trim();
    if (!url) return onshapeUrl.focus();
    onshapeBtn.disabled = true;
    onshapeBtn.textContent = 'Loading…';
    try {
      const rows = await api('POST', '/api/onshape/bom', { url });
      if (!rows.length) throw new Error('No parts found in that Onshape tab.');
      start(rows.map((r) => ({ ...r, qty: r.qty || 1 })));
    } catch (err) {
      toast(err.message, true);
    } finally {
      onshapeBtn.disabled = false;
      onshapeBtn.textContent = 'Load from Onshape';
    }
  }

  const intro = h('div', { class: 'import-intro' },
    h('div', { class: 'form import-options' },
      field('Mechanism for these parts', mech),
      h('label', { class: 'check-label' }, subtract, 'Only order what we don\'t already have in inventory')),
    h('div', { class: 'onshape-box' },
      field('Onshape assembly or Part Studio link', h('div', { class: 'inline' }, onshapeUrl, onshapeBtn)),
      h('p', { class: 'note' }, state.onshapeConnected
        ? 'Open the assembly in Onshape and copy the address bar. Every part in its bill of materials is loaded.'
        : 'Onshape isn\'t connected yet: an admin can add the team\'s API keys under Settings → Onshape. Until then, use a CSV export below.')),
    h('div', { class: 'or-divider' }, 'or import a CSV'),
    h('p', { class: 'note' },
      'In Onshape, open the assembly\'s Bill of Materials, switch it to Structured or Flattened, and choose Export → CSV. ',
      'Any CSV works as long as it has a "Part number" column (and ideally "Quantity" and "Name"). ',
      'Part numbers that match a supplier SKU (WCP-0940, am-3402, TTB-0347, REV-21-1650, McMaster numbers…) are looked up and ordered; everything else goes onto the manufacturing board to be made.'),
    h('div', { class: 'form' },
      field('BOM file', fileInput, 'full'),
      h('div', { class: 'full' }, paste)),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => start() }, 'Read BOM')));

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (f) {
      paste.value = await f.text();
      start();
    }
  });

  function start(fromOnshape) {
    let bom;
    if (fromOnshape) {
      bom = fromOnshape;
    } else {
      const rows = parseCsv(paste.value);
      if (rows.length < 2) return toast('That file has no data rows.', true);
      const cols = guessColumns(rows[0]);
      if (cols.partNumber < 0 && cols.name < 0) return toast('Could not find a "Part number" or "Name" column.', true);
      bom = toBomRows(rows.slice(1), cols);
    }
    if (!bom.length) return toast('No parts found in that file.', true);
    items = bom.map((b) => ({ ...b, action: 'skip', match: null, supplier: null, variantId: null, orderQty: b.qty, matched: false }));
    intro.hidden = true;
    renderTable();
    matchAll();
  }

  async function matchAll() {
    const withPn = items.map((it, i) => ({ it, i })).filter(({ it }) => it.partNumber);
    let done = 0;
    for (let k = 0; k < withPn.length; k += 12) {
      const batch = withPn.slice(k, k + 12);
      fill(footerTotal, `Looking up part numbers… ${done}/${withPn.length}`);
      try {
        const res = await api('POST', '/api/match', { rows: batch.map(({ it }) => ({ partNumber: it.partNumber, description: it.name || it.description })) });
        res.forEach((r, j) => {
          const it = batch[j].it;
          it.supplier = r.supplier;
          if (r.match) {
            it.match = r.match.product;
            it.variantId = r.match.variantId;
          }
          it.matched = true;
          applyInventory(it);
        });
      } catch (err) {
        toast(err.message, true);
        batch.forEach(({ it }) => (it.matched = true));
      }
      done += batch.length;
      renderTable();
    }
    items.forEach((it) => {
      it.matched = true;
      applyInventory(it);
    });
    renderTable();
  }

  const variantOf = (it) => it.match?.variants.find((v) => String(v.id) === String(it.variantId)) || it.match?.variants[0];

  function inventoryHave(it) {
    const v = variantOf(it);
    return inventoryFor({ supplier: it.match?.supplier || it.supplier, variant_id: v?.id, sku: v?.sku || it.partNumber, name: it.name }).qty;
  }

  // Already on the manufacturing board (same part number, or same name)?
  const onBoard = (it) => state.customParts.find((p) =>
    (it.partNumber && p.part_number && p.part_number.toLowerCase() === it.partNumber.toLowerCase()) ||
    (!it.partNumber && it.name && p.name.toLowerCase() === it.name.toLowerCase()));

  // Supplier parts get ordered (minus what's on the shelf); everything else is made in-house.
  function applyInventory(it) {
    it.have = inventoryHave(it);
    if (it.match || it.supplier) {
      it.orderQty = subtract.checked ? Math.max(0, it.qty - it.have) : it.qty;
      it.action = it.orderQty > 0 ? 'order' : 'skip';
    } else {
      it.existing = onBoard(it);
      it.orderQty = it.qty;
      it.action = it.existing ? 'skip' : 'make';
    }
  }

  subtract.addEventListener('change', () => {
    items.forEach(applyInventory);
    renderTable();
  });

  function renderTable() {
    const rows = items.map((it) => {
      const v = variantOf(it);
      const price = v?.priceCents ?? null;
      const action = h('select', { class: `action-select ${it.action}`, 'aria-label': 'What to do', disabled: !it.matched && !!it.partNumber,
        onchange: (e) => { it.action = e.target.value; renderTable(); } },
      [['order', 'Order'], ['make', 'Make'], ['skip', 'Skip']].map(([v, l]) => h('option', { value: v, selected: it.action === v }, l)));
      const qty = h('input', { type: 'number', min: 0, value: it.orderQty, class: 'qty-input', 'aria-label': 'Quantity to order', oninput: (e) => { it.orderQty = Number(e.target.value) || 0; updateTotal(); } });
      let matchCell;
      if (!it.matched && it.partNumber) matchCell = h('span', { class: 'note' }, 'Looking up…');
      else if (it.match && it.match.variants.length > 1) {
        matchCell = h('div', {},
          h('div', { class: 'part-name' }, it.match.title),
          h('select', { class: 'variant-select', onchange: (e) => { it.variantId = e.target.value; applyInventory(it); renderTable(); } },
            it.match.variants.map((x) => h('option', { value: x.id, selected: String(x.id) === String(it.variantId) }, `${x.title}${x.sku ? ' · ' + x.sku : ''}`))));
      } else if (it.match) {
        matchCell = h('div', { class: 'part-name' }, v?.name || it.name || it.partNumber);
      } else if (it.existing) {
        matchCell = h('span', { class: 'note' }, `Already on the board (${state.columns.find((c) => c.id === it.existing.column_id)?.name || 'board'})`);
      } else {
        matchCell = h('span', { class: 'note' }, it.material ? `Custom part · ${it.material}` : 'Custom part (no supplier match)');
      }
      if (it.action === 'make' && it.match) matchCell = h('span', { class: 'note' }, 'Will be made in-house instead of ordered');
      return h('tr', { class: it.action === 'skip' ? 'muted' : '' },
        h('td', {}, action),
        h('td', {}, h('div', { class: 'part-name' }, it.name || it.description || it.partNumber), h('div', { class: 'part-sub' }, it.partNumber || '—')),
        h('td', { class: 'num' }, it.qty),
        h('td', { class: 'num' }, it.matched ? (it.have || '—') : ''),
        h('td', { class: 'num' }, qty),
        h('td', {}, matchCell),
        h('td', {}, it.match || it.supplier ? supplierName(it.match?.supplier || it.supplier) : '—'),
        h('td', { class: 'num' }, money(price)));
    });
    fill(area, h('div', { class: 'import-table-wrap' }, h('table', { class: 'plain import-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Action'), h('th', {}, 'BOM part'), h('th', { class: 'num' }, 'BOM qty'), h('th', { class: 'num' }, 'Have'),
        h('th', { class: 'num' }, 'Qty'), h('th', {}, 'Supplier product / custom part'), h('th', {}, 'Supplier'), h('th', { class: 'num' }, 'Each'))),
      h('tbody', {}, rows))));
    updateTotal();
  }

  const toOrder = () => items.filter((it) => it.action === 'order' && it.orderQty > 0);
  const toMake = () => items.filter((it) => it.action === 'make' && it.orderQty > 0);

  function updateTotal() {
    const orders = toOrder();
    const makes = toMake();
    const total = orders.reduce((n, it) => n + (variantOf(it)?.priceCents || 0) * it.orderQty, 0);
    const busy = items.some((it) => !it.matched);
    if (!busy) fill(footerTotal, `Order ${plural(orders.length, 'part')} (${money(total)}) · make ${plural(makes.length, 'custom part')}`);
    importBtn.disabled = busy || !(orders.length + makes.length);
  }

  importBtn.addEventListener('click', async () => {
    const mechanism_id = mech.value ? Number(mech.value) : null;
    const orders = toOrder().map((it) => {
      const v = variantOf(it);
      const p = it.match;
      const supplier = p?.supplier || it.supplier || null;
      const sp = supplierByKey(supplier);
      return {
        name: v?.name || it.name || it.description || it.partNumber,
        description: it.description || null,
        supplier,
        sku: v?.sku || it.partNumber || null,
        url: p ? (sp?.platform === 'shopify' && p.variants.length > 1 ? `${p.url}?variant=${v.id}` : p.url) : null,
        image: v?.image || p?.image || null,
        product_id: p?.productId || null,
        variant_id: v?.id || null,
        variant_title: v?.title || null,
        unit_price_cents: v?.priceCents ?? null,
        quantity: it.orderQty,
        mechanism_id,
        notes: 'From BOM import',
      };
    });
    const parts = toMake().map((it) => ({
      name: it.name || it.description || it.partNumber,
      part_number: it.partNumber || null,
      quantity: it.orderQty,
      material: it.material || null,
      cad_url: it.cadUrl || null,
      mechanism_id,
      notes: it.description && it.name ? it.description : null,
    }));
    importBtn.disabled = true;
    try {
      const created = orders.length ? await api('POST', '/api/orders/bulk', { orders }) : [];
      const made = parts.length ? await api('POST', '/api/custom-parts/bulk', { parts }) : [];
      const pending = created.filter((o) => o.approval === 'pending').length;
      closeModal();
      toast([
        created.length ? `${plural(created.length, 'part request')}${pending ? ` (${pending} awaiting approval)` : ''}` : null,
        made.length ? `${plural(made.length, 'custom part')} added to the board` : null,
      ].filter(Boolean).join(' · '));
      refresh();
    } catch (err) {
      importBtn.disabled = false;
      toast(err.message, true);
    }
  });

  openModal('Import BOM', h('div', {}, intro, area), [footerTotal, h('button', { class: 'btn', onclick: closeModal }, 'Cancel'), importBtn], 'wide');
}
