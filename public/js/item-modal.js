// Add/edit dialog for part requests and inventory items, with supplier search and variant picking.
import {
  h, fill, api, money, toCents, fromCents, toast, prefs, state, STATUS_LABEL, PRIORITIES,
  supplierByKey, supplierName, variantUrl, inventoryFor, stockPill, openModal, closeModal, refresh,
  isMentor, approvalRequired, field, canEditOrder, photoPicker,
} from './core.js';
import { rejectRequest } from './orders.js';

// `seed` pre-fills a new item (e.g. "Order more" from inventory).
export function openItemModal(mode, existing = null, seed = null) {
  const isOrder = mode === 'order';
  const mentor = isMentor();
  const readOnly = isOrder && existing && !canEditOrder(existing);
  const src = existing || seed || {};
  const f = {
    description: src.description || '',
    image: src.image || '',
    product_id: src.product_id || null,
    variant_id: src.variant_id || null,
    variant_title: src.variant_title || null,
    mechanism_id: src.mechanism_id ?? (state.ui.orderMechanism && state.ui.orderMechanism !== 'none' ? Number(state.ui.orderMechanism) : null),
  };
  let product = null; // product currently loaded from a supplier
  let saveBtn = null;
  let searchToken = 0;
  const searchable = state.suppliers.filter((s) => s.searchable || s.platform === 'mcmaster');
  const chosenSuppliers = new Set(prefs.get('searchSuppliers', searchable.map((s) => s.key)).filter((k) => searchable.some((s) => s.key === k)));
  if (!chosenSuppliers.size) searchable.forEach((s) => chosenSuppliers.add(s.key));

  // --- form fields ---
  const inputs = {
    name: h('input', { type: 'text', value: src.name || '', required: true }),
    sku: h('input', { type: 'text', value: src.sku || '' }),
    price: h('input', { type: 'number', min: 0, step: '0.01', value: fromCents(src.unit_price_cents) }),
    quantity: h('input', { type: 'number', min: 0, value: existing ? existing.quantity : 1 }),
    mechanism: h('select', {}, h('option', { value: '' }, 'Unassigned'),
      state.mechanisms.map((m) => h('option', { value: m.id, selected: f.mechanism_id === m.id }, m.name))),
    status: h('select', {}, Object.entries(STATUS_LABEL).map(([v, l]) => h('option', { value: v, selected: (existing?.status || 'needed') === v }, l))),
    priority: h('select', {}, PRIORITIES.map((p) => h('option', { value: p, selected: (existing?.priority || 'normal') === p }, p[0].toUpperCase() + p.slice(1)))),
    requested_by: h('input', { type: 'text', value: existing?.requested_by || state.user.display_name }),
    order_number: h('input', { type: 'text', value: existing?.order_number || '' }),
    tracking_number: h('input', { type: 'text', value: existing?.tracking_number || '' }),
    location: h('input', { type: 'text', value: existing?.location || '', placeholder: 'Bin / shelf' }),
    min_quantity: h('input', { type: 'number', min: 0, value: existing?.min_quantity || 0 }),
    url: h('input', { type: 'url', value: src.url || '', placeholder: 'https://…' }),
    notes: h('textarea', { rows: 2 }, existing?.notes || ''),
  };
  const builtIns = state.suppliers.filter((s) => !s.custom);
  const vendors = state.suppliers.filter((s) => s.custom);
  const supplierSelect = h('select', { 'aria-label': 'Supplier' },
    h('option', { value: '' }, 'Choose a supplier…'),
    h('optgroup', { label: 'Built-in suppliers' }, builtIns.map((s) => h('option', { value: s.key }, s.name))),
    vendors.length ? h('optgroup', { label: 'Other vendors' }, vendors.map((s) => h('option', { value: s.key }, s.name))) : null,
    h('option', { value: '__other' }, '+ Other vendor…'));
  const otherName = h('input', { type: 'text', placeholder: 'e.g. Misumi, Amazon, local metal shop' });
  const otherSite = h('input', { type: 'url', placeholder: 'https://… (optional)' });
  const otherBox = h('div', { class: 'full other-vendor', hidden: true },
    h('div', { class: 'form' }, field('New vendor name', otherName), field('Vendor website', otherSite)),
    h('p', { class: 'note' }, 'It\'s saved to the vendor list, so the next person can just pick it.'));

  // Select a supplier by key; names typed on older orders get their own option.
  function setSupplier(key) {
    if (key && !supplierByKey(key) && ![...supplierSelect.options].some((o) => o.value === key)) {
      supplierSelect.insertBefore(h('option', { value: key }, key), supplierSelect.lastElementChild);
    }
    supplierSelect.value = supplierByKey(key)?.key || key || '';
    otherBox.hidden = true;
  }
  setSupplier(src.supplier);
  supplierSelect.addEventListener('change', () => {
    otherBox.hidden = supplierSelect.value !== '__other';
    if (!otherBox.hidden) otherName.focus();
    updateHints();
  });
  const variantField = h('label', { class: 'field full', hidden: true }, h('span', {}, 'Variant'));
  const previewBox = h('div', { class: 'full preview' });
  const stockBox = h('div', { class: 'full' });
  const hintBox = h('div', { class: 'full' });

  const supplierKeyFromInput = () => (supplierSelect.value === '__other' ? otherName.value.trim() || null : supplierSelect.value || null);

  // Photo: filled from the supplier when a product is picked; otherwise upload, paste or drop one.
  const photo = photoPicker({ getUrl: () => f.image || null, setUrl: (url) => { f.image = url || ''; } });

  function updatePreview() {
    photo.redraw();
    fill(previewBox,
      product && product.title ? h('div', {}, h('div', { class: 'part-name' }, product.title),
        h('div', { class: 'part-sub' }, supplierName(product.supplier), product.variants.length > 1 ? ` · ${product.variants.length} variants` : '')) : null);
    updateHints();
  }

  function updateHints() {
    if (!isOrder) return fill(stockBox);
    const match = inventoryFor({ supplier: supplierKeyFromInput(), variant_id: f.variant_id, sku: inputs.sku.value.trim(), name: inputs.name.value.trim() });
    const sku = inputs.sku.value.trim().toLowerCase();
    const ordered = state.orders.filter((o) => o.id !== existing?.id && o.status !== 'arrived' &&
      ((f.variant_id && o.variant_id === f.variant_id) || (sku && o.sku && o.sku.toLowerCase() === sku)));
    fill(stockBox,
      match.items.length ? h('div', { class: match.qty > 0 ? 'ok-box' : 'warn-box' },
        match.qty > 0 ? `You already have ${match.qty} in inventory` : 'In inventory, but out of stock',
        match.items.some((i) => i.location) ? ` (${[...new Set(match.items.map((i) => i.location).filter(Boolean))].join(', ')})` : '', '.') : null,
      ordered.length ? h('div', { class: 'warn-box', style: { marginTop: '6px' } },
        `Already requested: ${ordered.map((o) => `${o.quantity} ${STATUS_LABEL[o.status].toLowerCase()}`).join(', ')}.`) : null);

    // Tell students up front when a mentor has to sign off.
    if (!mentor && approvalRequired()) {
      const total = (toCents(inputs.price.value) || 0) * (Number(inputs.quantity.value) || 0);
      const threshold = Number(state.settings.approval_threshold_cents) || 0;
      const needs = total > threshold || !inputs.price.value;
      fill(hintBox, needs ? h('div', { class: 'approval-note' }, threshold
        ? `Requests over ${money(threshold)} (or without a price) go to a mentor for approval before they're ordered.`
        : 'This request goes to a mentor for approval before it is ordered.') : null);
      if (saveBtn && isOrder) {
        if (!existing) saveBtn.textContent = needs ? 'Submit for approval' : 'Add part';
        else saveBtn.textContent = existing.approval === 'rejected' ? 'Save & resubmit' : 'Save';
      }
    }
  }
  [inputs.sku, inputs.price, inputs.quantity].forEach((el) => el.addEventListener('input', updateHints));
  inputs.name.addEventListener('change', updateHints);

  // The fix for variant names: picking a variant always rewrites the part name, SKU, price, link and image.
  function applyVariant(v) {
    f.variant_id = v.id;
    f.variant_title = v.title;
    f.product_id = product.productId;
    f.image = v.image || product.image || '';
    if (v.name) inputs.name.value = v.name;
    inputs.sku.value = v.sku || '';
    inputs.price.value = fromCents(v.priceCents);
    inputs.url.value = variantUrl(product, v);
    setSupplier(product.supplier);
    updatePreview();
    if (product.needsName) {
      inputs.name.focus();
      toast(`${supplierName(product.supplier)} pages can't be read automatically. Type the part name and price.`);
    }
  }

  function showVariants(p, selectedId) {
    if (p.variants.length > 1) {
      const sel = h('select', { onchange: (e) => applyVariant(p.variants.find((v) => String(v.id) === e.target.value)) },
        p.variants.map((v) => h('option', { value: v.id, selected: String(v.id) === String(selectedId) },
          `${v.title}${v.sku ? ` · ${v.sku}` : ''} · ${money(v.priceCents)}${v.available === false ? ' · sold out' : ''}`)));
      fill(variantField, h('span', {}, `Variant (${p.variants.length})`), sel);
      variantField.hidden = false;
    } else {
      variantField.hidden = true;
      showSiblings(p);
    }
  }

  // Stores that sell each size as its own product (WCP gears, spacers…): offer the other sizes here too.
  let siblingToken = 0;
  async function showSiblings(p) {
    const token = ++siblingToken;
    const sup = supplierByKey(p.supplier);
    if (!sup?.searchable || !p.title) return;
    let list;
    try {
      list = await api('GET', `/api/siblings?supplier=${encodeURIComponent(p.supplier)}&handle=${encodeURIComponent(p.handle)}&title=${encodeURIComponent(p.title)}&product_id=${encodeURIComponent(p.productId || '')}`);
    } catch {
      return;
    }
    if (token !== siblingToken || product !== p || list.length < 2) return;
    const sel = h('select', { onchange: async (e) => {
      const pick = list[Number(e.target.value)];
      sel.disabled = true;
      try {
        const next = await api('GET', `/api/product?supplier=${encodeURIComponent(p.supplier)}&handle=${encodeURIComponent(pick.handle)}`);
        list.forEach((x) => (x.current = x === pick));
        product = next;
        siblingToken++; // keep this list instead of looking it up again
        applyVariant(next.variants[0]);
        sel.disabled = false;
      } catch (err) {
        toast(`Couldn't load that size: ${err.message}`, true);
        sel.disabled = false;
      }
    } }, list.map((x, i) => h('option', { value: i, selected: x.current }, `${x.label}${x.priceCents != null && !x.current ? ` · ${money(x.priceCents)}` : ''}`)));
    fill(variantField, h('span', {}, `Other sizes / versions (${list.length})`), sel);
    variantField.hidden = false;
  }

  function loadProduct(p, selectedId) {
    product = p;
    showVariants(p, selectedId);
    applyVariant(p.variants.find((v) => String(v.id) === String(selectedId)) || p.variants[0]);
  }

  // --- search column ---
  const results = h('div', { class: 'results' });
  const q = h('input', { type: 'search', placeholder: 'Search parts or paste a product URL…' });
  const chips = h('div', { class: 'chips' }, searchable.map((s) => {
    const chip = h('span', { class: 'chip' + (chosenSuppliers.has(s.key) ? ' on' : ''), onclick: () => {
      chosenSuppliers.has(s.key) ? chosenSuppliers.delete(s.key) : chosenSuppliers.add(s.key);
      chip.classList.toggle('on');
      prefs.set('searchSuppliers', [...chosenSuppliers]);
      if (q.value.trim()) runSearch();
      else showFavorites();
    } }, s.name);
    return chip;
  }));

  // The parts this team orders most from the selected suppliers, from order history.
  function favorites() {
    const groups = new Map();
    for (const o of state.orders) {
      if (!chosenSuppliers.has(o.supplier) || o.approval === 'rejected') continue;
      const key = `${o.supplier}|${o.variant_id || (o.sku || '').toLowerCase() || o.name.toLowerCase()}`;
      const g = groups.get(key) || { times: 0, qty: 0, latest: o };
      g.times++;
      g.qty += o.quantity;
      if (o.id > g.latest.id) g.latest = o;
      groups.set(key, g);
    }
    return [...groups.values()]
      .sort((a, b) => b.times - a.times || b.qty - a.qty || b.latest.id - a.latest.id)
      .slice(0, 15);
  }

  function showFavorites() {
    if (!chosenSuppliers.size) return results.replaceChildren(h('div', { class: 'msg' }, 'Pick at least one supplier above.'));
    const favs = favorites();
    const only = chosenSuppliers.size === 1 ? supplierName([...chosenSuppliers][0]) : null;
    if (!favs.length) {
      return results.replaceChildren(h('div', { class: 'msg' },
        `${only ? `Nothing has been ordered from ${only} yet.` : 'No order history for these suppliers yet.'} Search above, or paste a product link (McMaster links work too).`));
    }
    fill(results,
      h('div', { class: 'results-head' }, only ? `Most used from ${only}` : 'Most used by the team'),
      favs.map((g) => {
        const o = g.latest;
        const s = supplierByKey(o.supplier);
        const row = h('div', { class: 'result', onclick: () => pickFavorite(o, row) },
          o.image ? h('img', { src: o.image, alt: '', loading: 'lazy' }) : h('div', { class: 'thumb-ph' }),
          h('div', {},
            h('div', { class: 't' }, o.name),
            h('div', { class: 's' },
              h('span', { class: 'pill' }, h('span', { class: 'dot', style: { background: s?.color } }), s?.name || o.supplier),
              h('span', {}, money(o.unit_price_cents)),
              o.sku ? h('span', {}, o.sku) : null,
              h('span', { title: `${g.qty} total` }, `ordered ${g.times}×`),
              stockPill(inventoryFor(o)))));
        return row;
      }));
  }

  // Fill the form from a past order, then refresh price/variants from the supplier when possible.
  async function pickFavorite(o, row) {
    results.querySelectorAll('.result').forEach((x) => x.classList.remove('sel'));
    row.classList.add('sel');
    product = null;
    Object.assign(f, { image: o.image || '', product_id: o.product_id, variant_id: o.variant_id, variant_title: o.variant_title, description: o.description || '' });
    inputs.name.value = o.name;
    setSupplier(o.supplier);
    inputs.sku.value = o.sku || '';
    inputs.price.value = fromCents(o.unit_price_cents);
    inputs.url.value = o.url || '';
    if (o.mechanism_id && !inputs.mechanism.value) inputs.mechanism.value = o.mechanism_id;
    variantField.hidden = true;
    updatePreview();
    inputs.quantity.focus();
    if (!o.url || !supplierByKey(o.supplier)?.searchable) return;
    try {
      const p = await api('GET', `/api/lookup?url=${encodeURIComponent(o.url)}`);
      if (!row.classList.contains('sel')) return; // picked something else meanwhile
      loadProduct(p, o.variant_id || p.selectedVariantId);
    } catch {
      // keep the saved details if the supplier can't be reached
    }
  }

  async function pickResult(r, row) {
    results.querySelectorAll('.result').forEach((x) => x.classList.remove('sel'));
    row?.classList.add('sel');
    try {
      const p = await api('GET', `/api/product?supplier=${encodeURIComponent(r.supplier)}&handle=${encodeURIComponent(r.handle)}`);
      loadProduct(p);
      if (!p.needsName) inputs.quantity.focus();
    } catch (err) {
      toast(`Couldn't load product: ${err.message}`, true);
    }
  }

  function mcmasterRows(text) {
    const s = supplierByKey('mcmaster');
    const pn = text.replace(/\s+/g, '').toUpperCase();
    const out = [];
    if (/^\d{4,5}[A-Z]\d{1,4}$/.test(pn)) {
      const row = h('div', { class: 'result', onclick: async () => {
        results.querySelectorAll('.result').forEach((x) => x.classList.remove('sel'));
        row.classList.add('sel');
        try {
          const p = await api('GET', `/api/lookup?url=${encodeURIComponent(`https://www.mcmaster.com/${pn}/`)}`);
          loadProduct(p, p.selectedVariantId);
        } catch (err) {
          toast(err.message, true);
        }
      } },
      h('div', { class: 'thumb-ph' }),
      h('div', {}, h('div', { class: 't' }, `McMaster-Carr part ${pn}`),
        h('div', { class: 's' }, h('span', { class: 'pill' }, h('span', { class: 'dot', style: { background: s?.color } }), s?.name), h('span', {}, 'Click to fill in, then add the name and price'))));
      out.push(row);
    }
    out.push(h('a', { class: 'result mc-search', href: `https://www.mcmaster.com/products/${encodeURIComponent(text)}/`, target: '_blank', rel: 'noopener' },
      h('div', { class: 'thumb-ph' }),
      h('div', {}, h('div', { class: 't' }, `Search McMaster-Carr for "${text}" ↗`),
        h('div', { class: 's' }, h('span', {}, 'McMaster can\'t be searched from here. Find the part there, copy the page link, and paste it in the search box above.')))));
    return out;
  }

  async function runSearch() {
    const text = q.value.trim();
    if (!text) return;
    const token = ++searchToken;
    if (/^https?:\/\//i.test(text)) {
      results.replaceChildren(h('div', { class: 'msg' }, 'Looking up link…'));
      try {
        const p = await api('GET', `/api/lookup?url=${encodeURIComponent(text)}`);
        loadProduct(p, p.selectedVariantId);
        results.replaceChildren(h('div', { class: 'msg' }, p.title ? `Loaded "${p.title}" from ${supplierName(p.supplier)}.` : `Filled in the ${supplierName(p.supplier)} part number.`));
      } catch (err) {
        inputs.url.value = text;
        results.replaceChildren(h('div', { class: 'msg' }, err.message));
      }
      return;
    }
    if (!chosenSuppliers.size) return results.replaceChildren(h('div', { class: 'msg' }, 'Pick at least one supplier above.'));
    results.replaceChildren(h('div', { class: 'msg' }, 'Searching…'));
    try {
      const data = await api('GET', `/api/search?q=${encodeURIComponent(text)}&suppliers=${[...chosenSuppliers].join(',')}`);
      if (token !== searchToken) return;
      const rows = data.results.map((r) => {
        const stock = inventoryFor({ supplier: r.supplier, product_id: r.productId, sku: r.sku }, { productLevel: !r.sku });
        const s = supplierByKey(r.supplier);
        const row = h('div', { class: 'result', onclick: () => pickResult(r, row) },
          r.image ? h('img', { src: r.image, alt: '', loading: 'lazy' }) : h('div', { class: 'thumb-ph' }),
          h('div', {},
            h('div', { class: 't' }, r.title),
            h('div', { class: 's' },
              h('span', { class: 'pill' }, h('span', { class: 'dot', style: { background: s?.color } }), s?.name || r.supplier),
              h('span', {}, r.priceMaxCents && r.priceMaxCents !== r.priceCents ? `${money(r.priceCents)}–${money(r.priceMaxCents)}` : money(r.priceCents)),
              r.sku ? h('span', {}, r.sku) : null,
              r.available === false ? h('span', {}, 'sold out') : null,
              stockPill(stock))));
        return row;
      });
      const errs = data.errors.map((e) => h('div', { class: 'msg' }, `${supplierName(e.supplier)}: ${e.message}`));
      const mc = chosenSuppliers.has('mcmaster') ? mcmasterRows(text) : [];
      fill(results, mc, rows.length || mc.length ? rows : h('div', { class: 'msg' }, 'No matches.'), errs);
    } catch (err) {
      results.replaceChildren(h('div', { class: 'msg' }, err.message));
    }
  }
  let debounce;
  q.addEventListener('input', () => {
    clearTimeout(debounce);
    if (!q.value.trim()) {
      searchToken++; // drop any search still in flight
      showFavorites();
    } else if (!/^https?:\/\//i.test(q.value.trim())) debounce = setTimeout(runSearch, 450);
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(debounce);
      runSearch();
    }
  });

  // --- assemble ---
  let approvalBanner = null;
  if (isOrder && existing?.approval === 'pending') {
    approvalBanner = h('div', { class: 'full approval-note' }, mentor
      ? `Waiting for approval. Requested by ${existing.requested_by || 'unknown'}. Approve or reject below.`
      : 'Waiting for a mentor to approve this request.');
  } else if (isOrder && existing?.approval === 'rejected') {
    approvalBanner = h('div', { class: 'full warn-box' },
      `Rejected${existing.approved_by ? ` by ${existing.approved_by}` : ''}${existing.rejection_reason ? `: ${existing.rejection_reason}` : '.'}`,
      canEditOrder(existing) && !mentor ? ' Change what you need and click "Save & resubmit".' : '');
  }
  const form = h('div', { class: 'form' },
    approvalBanner,
    previewBox,
    readOnly ? (f.image ? h('div', { class: 'full preview' }, h('img', { src: f.image, alt: '' })) : null) : h('div', { class: 'full' }, photo),
    variantField,
    field('Part name', inputs.name, 'full'),
    field('Supplier', supplierSelect), field('SKU / part #', inputs.sku),
    otherBox,
    field('Unit price ($)', inputs.price), field(isOrder ? 'Quantity needed' : 'Quantity on hand', inputs.quantity),
    field('Mechanism', inputs.mechanism),
    isOrder ? field('Priority', inputs.priority) : field('Location', inputs.location),
    !isOrder ? field('Minimum to keep on hand', inputs.min_quantity) : null,
    isOrder && mentor ? field('Status', inputs.status) : null,
    isOrder && mentor ? field('Requested by', inputs.requested_by) : null,
    isOrder && mentor && existing ? field('Supplier order #', inputs.order_number) : null,
    isOrder && mentor && existing ? field('Tracking #', inputs.tracking_number) : null,
    field('Product link', inputs.url, 'full'),
    field('Notes', inputs.notes, 'full'),
    hintBox,
    stockBox);
  if (readOnly) form.querySelectorAll('input, select, textarea').forEach((el) => (el.disabled = true));

  const body = readOnly ? form : h('div', { class: 'picker' },
    h('div', { class: 'col' }, h('div', { class: 'searchrow' }, q, h('button', { class: 'btn', onclick: runSearch }, 'Search')), chips, results),
    h('div', { class: 'col' }, form));

  async function save(after) {
    const name = inputs.name.value.trim();
    if (!name) {
      inputs.name.focus();
      return toast('Part name is required', true);
    }
    if (supplierSelect.value === '__other') {
      if (!otherName.value.trim()) {
        otherName.focus();
        return toast('Type the vendor name', true);
      }
      try {
        const v = await api('POST', '/api/vendors', { name: otherName.value.trim(), website: otherSite.value.trim() });
        otherName.value = v.name;
      } catch (err) {
        return toast(err.message, true);
      }
    }
    // If the URL was edited away from the loaded product, drop the product link data.
    const keepProduct = product && inputs.url.value.split('?')[0] === product.url.split('?')[0];
    const data = {
      name,
      supplier: supplierKeyFromInput(),
      sku: inputs.sku.value.trim() || null,
      url: inputs.url.value.trim() || null,
      image: f.image || null,
      product_id: keepProduct || !product ? f.product_id : null,
      variant_id: keepProduct || !product ? f.variant_id : null,
      variant_title: keepProduct || !product ? f.variant_title : null,
      description: product?.description || f.description || null,
      unit_price_cents: toCents(inputs.price.value),
      quantity: Math.max(0, Number(inputs.quantity.value) || 0),
      mechanism_id: inputs.mechanism.value ? Number(inputs.mechanism.value) : null,
      notes: inputs.notes.value.trim() || null,
    };
    if (isOrder) {
      data.priority = inputs.priority.value;
      if (mentor) {
        Object.assign(data, { status: inputs.status.value, requested_by: inputs.requested_by.value.trim() || null });
        if (existing) Object.assign(data, { order_number: inputs.order_number.value.trim() || null, tracking_number: inputs.tracking_number.value.trim() || null });
      }
    } else {
      data.location = inputs.location.value.trim() || null;
      data.min_quantity = Math.max(0, Number(inputs.min_quantity.value) || 0);
    }
    try {
      const base = isOrder ? '/api/orders' : '/api/inventory';
      let saved = existing ? await api('PATCH', `${base}/${existing.id}`, data) : await api('POST', base, data);
      if (after) saved = await after(saved);
      closeModal();
      toast(after ? 'Approved' : isOrder && saved.approval === 'pending' ? 'Sent to a mentor for approval' : existing ? 'Saved' : isOrder ? 'Part added' : 'Added to inventory');
      refresh();
    } catch (err) {
      toast(err.message, true);
    }
  }

  const canDelete = existing && (isOrder ? canEditOrder(existing) : mentor);
  const pendingForMentor = isOrder && mentor && existing?.approval === 'pending';
  saveBtn = readOnly ? null : h('button', { class: 'btn primary', onclick: () => save() }, existing ? 'Save' : isOrder ? 'Add part' : 'Add to inventory');
  const footer = [
    canDelete ? h('button', { class: 'btn danger', style: { marginRight: 'auto' }, onclick: async () => {
      if (!confirm(`Delete "${existing.name}"? This cannot be undone.`)) return;
      try {
        await api('DELETE', `${isOrder ? '/api/orders' : '/api/inventory'}/${existing.id}`);
        closeModal();
        refresh();
      } catch (err) {
        toast(err.message, true);
      }
    } }, 'Delete') : null,
    h('button', { class: 'btn', onclick: closeModal }, readOnly ? 'Close' : 'Cancel'),
    pendingForMentor ? h('button', { class: 'btn danger', onclick: () => { closeModal(); rejectRequest(existing); } }, 'Reject') : null,
    pendingForMentor ? h('button', { class: 'btn ok', onclick: () => save((o) => api('POST', `/api/orders/${o.id}/approve`)) }, 'Save & approve') : null,
    saveBtn,
  ];

  const title = readOnly ? 'Part details' : existing ? (isOrder ? 'Edit part' : 'Edit inventory item') : isOrder ? 'Add part to order' : 'Add to inventory';
  openModal(title, body, footer, readOnly ? 'narrow' : '');
  updatePreview();
  updateHints();
  showFavorites();
  if (!existing && !seed) q.focus();

  // Editing a supplier part: reload its variants so the variant can be switched.
  const sup = supplierByKey(src.supplier);
  if (!readOnly && src.product_id && sup?.searchable && src.url) {
    api('GET', `/api/lookup?url=${encodeURIComponent(src.url)}`).then((p) => {
      if (!document.body.contains(form)) return;
      product = p;
      showVariants(p, f.variant_id);
      updatePreview();
    }).catch(() => {});
  }
}
