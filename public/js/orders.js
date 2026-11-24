// Orders tab: part requests grouped by mechanism / supplier / status.
import {
  h, api, money, lineTotal, plural, toast, attempt, prefs, state, STATUS_LABEL, PRIORITIES,
  supplierByKey, supplierName, inventoryFor, stockPill, supplierPill, mechPill, isLowStock, openOrdersFor,
  openModal, closeModal, refresh, render, seg, groupItems, rerenderKeepingFocus, stat, field,
  isMentor, canEditOrder, approvalRequired, trackingLink, detectCarrier, CARRIER_NAMES,
} from './core.js';
import { openItemModal } from './item-modal.js';
import { generateCart } from './carts.js';
import { openImportModal } from './import.js';
import { openReorderModal } from './inventory.js';

function filteredOrders() {
  const { orderStatus, orderSupplier, orderMechanism, orderQuery, orderSort } = state.ui;
  const q = orderQuery.trim().toLowerCase();
  const list = state.orders.filter((o) => {
    // Tabs: pending approval (incl. rejected) → approved, not yet ordered → ordered → arrived.
    if (orderStatus === 'pending' && o.approval === 'approved') return false;
    if (orderStatus === 'approved' && !(o.approval === 'approved' && o.status === 'needed')) return false;
    if (['ordered', 'arrived'].includes(orderStatus) && (o.approval !== 'approved' || o.status !== orderStatus)) return false;
    if (orderStatus === 'mine' && o.created_by !== state.user.id) return false;
    if (orderSupplier && (o.supplier || '') !== (orderSupplier === 'none' ? '' : orderSupplier)) return false;
    if (orderMechanism && String(o.mechanism_id ?? 'none') !== orderMechanism) return false;
    if (q && ![o.name, o.sku, o.notes, o.requested_by, o.order_number, o.tracking_number, supplierName(o.supplier)]
      .some((f) => (f || '').toLowerCase().includes(q))) return false;
    return true;
  });
  const prioRank = (p) => -PRIORITIES.indexOf(p);
  const sorters = {
    newest: (a, b) => b.id - a.id,
    name: (a, b) => a.name.localeCompare(b.name),
    priority: (a, b) => prioRank(a.priority) - prioRank(b.priority) || b.id - a.id,
    total: (a, b) => lineTotal(b) - lineTotal(a),
  };
  return list.sort(sorters[orderSort] || sorters.newest);
}

export function renderOrders() {
  const ui = state.ui;
  const orders = filteredOrders();
  const setUi = (k, v, persist = true) => {
    ui[k] = v;
    if (persist) prefs.set(k, v);
    render();
  };
  const live = state.orders.filter((o) => o.approval !== 'rejected');
  const needed = live.filter((o) => o.status === 'needed');
  const sum = (list) => list.reduce((n, o) => n + lineTotal(o), 0);
  const pending = state.orders.filter((o) => o.approval === 'pending');
  const usedSuppliers = [...new Set(state.orders.map((o) => o.supplier || 'none'))];

  const stats = h('div', { class: 'stats' },
    stat('Needed', needed.length),
    stat('Needed cost', money(sum(needed))),
    stat('On the way', live.filter((o) => o.status === 'ordered').length),
    approvalRequired() ? stat('Awaiting approval', pending.length, pending.length && isMentor() ? 'attn' : '') : stat('Open cost', money(sum(live.filter((o) => o.status !== 'arrived')))),
  );

  // Nudge when shelf stock has dropped below its minimum and nobody has asked for more yet.
  const low = state.inventory.filter((i) => isLowStock(i) && !openOrdersFor(i).length);
  const lowBanner = low.length ? h('div', { class: 'banner warn-box' },
    h('span', {}, `${plural(low.length, 'inventory item')} ${low.length === 1 ? 'is' : 'are'} below the minimum and not on order.`),
    h('button', { class: 'btn small', onclick: () => openReorderModal() }, 'Review & reorder')) : null;

  const count = (pred) => state.orders.filter(pred).length;
  const tab = (label, n) => (n ? `${label} (${n})` : label);
  const statusOptions = [
    ['pending', tab('Pending Approval', pending.length)],
    ['approved', tab('Approved', count((o) => o.approval === 'approved' && o.status === 'needed'))],
    ['ordered', tab('Ordered', count((o) => o.approval === 'approved' && o.status === 'ordered'))],
    ['arrived', 'Arrived'],
  ];
  if (!isMentor()) statusOptions.push(['mine', 'Mine']);

  const toolbar = h('div', { class: 'toolbar' },
    h('input', { type: 'search', placeholder: 'Filter parts…', value: ui.orderQuery, oninput: (e) => { ui.orderQuery = e.target.value; rerenderKeepingFocus(e.target); } }),
    seg(statusOptions, ui.orderStatus, (v) => setUi('orderStatus', v)),
    h('select', { onchange: (e) => setUi('orderSupplier', e.target.value, false) },
      h('option', { value: '' }, 'All suppliers'),
      usedSuppliers.map((k) => h('option', { value: k, selected: ui.orderSupplier === k }, k === 'none' ? 'No supplier' : supplierName(k)))),
    h('select', { onchange: (e) => setUi('orderMechanism', e.target.value, false) },
      h('option', { value: '' }, 'All mechanisms'),
      state.mechanisms.map((m) => h('option', { value: String(m.id), selected: ui.orderMechanism === String(m.id) }, m.name)),
      h('option', { value: 'none', selected: ui.orderMechanism === 'none' }, 'Unassigned')),
    h('div', { class: 'grow' }),
    h('span', { class: 'label' }, 'Group'),
    seg([['mechanism', 'Mechanism'], ['supplier', 'Supplier'], ['status', 'Status'], ['none', 'None']], ui.orderGroup, (v) => setUi('orderGroup', v)),
    h('select', { title: 'Sort', onchange: (e) => setUi('orderSort', e.target.value) },
      [['newest', 'Newest'], ['name', 'Name'], ['priority', 'Priority'], ['total', 'Line total']].map(([v, l]) =>
        h('option', { value: v, selected: ui.orderSort === v }, `Sort: ${l}`))),
    h('a', { class: 'btn', href: '/api/orders.csv' }, 'Export CSV'),
    h('button', { class: 'btn', onclick: openImportModal }, 'Import BOM'),
    h('button', { class: 'btn primary', onclick: () => openItemModal('order') }, '+ Add part'),
  );

  const emptyByTab = {
    pending: 'Nothing is waiting for approval.',
    approved: 'Nothing approved is waiting to be ordered.',
    ordered: 'Nothing is on the way right now.',
    arrived: 'Nothing has arrived yet.',
  };
  const empty = state.orders.length
    ? (ui.orderQuery || ui.orderSupplier || ui.orderMechanism ? 'No parts match these filters.' : emptyByTab[ui.orderStatus] || 'No parts match these filters.')
    : 'No parts yet. Click "+ Add part" to search the suppliers, or "Import BOM" to load an Onshape bill of materials.';
  const body = orders.length ? groupItems(orders, ui.orderGroup).map(orderGroup) : h('div', { class: 'empty' }, empty);

  return h('div', {}, stats, approvalBanner(pending), lowBanner, toolbar, body);
}

// Mentors: what's waiting on them. Students: where their own requests stand.
function approvalBanner(pending) {
  const showPending = () => {
    state.ui.orderStatus = 'pending';
    render();
  };
  if (isMentor()) {
    if (!pending.length) return null;
    const total = pending.reduce((n, o) => n + lineTotal(o), 0);
    return h('div', { class: 'banner approval-note' },
      h('span', {}, `${plural(pending.length, 'part request')} ${pending.length === 1 ? 'is' : 'are'} waiting for your approval (${money(total)}).`),
      h('span', { class: 'row' },
        state.ui.orderStatus !== 'pending' ? h('button', { class: 'btn small', onclick: showPending }, 'Review') : null,
        h('button', { class: 'btn small ok', onclick: () => {
          if (confirm(`Approve all ${plural(pending.length, 'request')} (${money(total)})?`)) approve(pending.map((o) => o.id));
        } }, 'Approve all')));
  }
  const mine = state.orders.filter((o) => o.created_by === state.user.id && o.status === 'needed');
  const waiting = mine.filter((o) => o.approval === 'pending').length;
  const rejected = mine.filter((o) => o.approval === 'rejected').length;
  if (!waiting && !rejected) return null;
  return h('div', { class: 'banner approval-note' },
    h('span', {}, [
      waiting ? `${plural(waiting, 'of your requests')} ${waiting === 1 ? 'is' : 'are'} waiting for a mentor's approval.` : null,
      rejected ? `${plural(rejected, 'request')} ${rejected === 1 ? 'was' : 'were'} rejected; open ${rejected === 1 ? 'it' : 'them'} to see why and resubmit.` : null,
    ].filter(Boolean).join(' ')),
    h('button', { class: 'btn small', onclick: () => { state.ui.orderStatus = 'mine'; render(); } }, 'Show mine'));
}

function orderGroup(g) {
  const sum = g.items.reduce((n, o) => n + (o.approval === 'rejected' ? 0 : lineTotal(o)), 0);
  const s = state.ui.orderGroup === 'supplier' ? supplierByKey(g.key) : null;
  const readyIds = g.items.filter((o) => o.status === 'needed' && o.approval === 'approved').map((o) => o.id);
  const mentor = isMentor();

  const head = g.label == null ? null : h('div', { class: 'group-head' },
    h('h3', {}, h('span', { class: 'dot', style: { background: g.color } }), g.label),
    h('span', { class: 'meta' }, `${plural(g.items.length, 'part')} · ${money(sum)}`),
    h('div', { class: 'spacer' }),
    mentor && s?.cartMode && readyIds.length ? h('button', { class: 'btn small primary', onclick: () => generateCart(s.key, readyIds) }, `Generate ${s.name} cart (${readyIds.length})`) : null,
  );

  return h('section', { class: 'group' }, head,
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', { class: 'w-thumb' }), h('th', {}, 'Part'),
        h('th', { class: 'hide-sm w-sup' }, 'Supplier'), h('th', { class: 'hide-sm w-mech' }, 'Mechanism'),
        h('th', { class: 'num w-qty' }, 'Qty'), h('th', { class: 'num hide-sm hide-md w-money' }, 'Each'), h('th', { class: 'num w-money' }, 'Total'),
        h('th', { class: 'w-inv' }, 'Inventory'), h('th', { class: 'w-status' }, 'Status'), h('th', { class: 'w-act' }))),
      h('tbody', {}, g.items.map(orderRow))));
}

function approvalCell(o) {
  if (o.approval === 'pending') {
    return isMentor()
      ? h('div', { class: 'approve-ctl' },
        h('button', { class: 'btn small ok', title: 'Approve', onclick: () => approve([o.id]) }, '✓ Approve'),
        h('button', { class: 'btn small danger', title: 'Reject', onclick: () => rejectRequest(o) }, '✕ Reject'))
      : h('span', { class: 'pill approval-pending' }, 'Awaiting approval');
  }
  if (o.approval === 'rejected') {
    return h('span', { class: 'pill approval-rejected', title: o.rejection_reason || '' }, 'Rejected');
  }
  if (!isMentor()) return h('span', { class: `pill status-${o.status}` }, STATUS_LABEL[o.status]);
  return h('select', { class: `status ${o.status}`, 'aria-label': 'Status', onchange: (e) => changeStatus(o, e.target.value) },
    Object.entries(STATUS_LABEL).map(([v, l]) => h('option', { value: v, selected: o.status === v }, l)));
}

function orderRow(o) {
  const sub = [
    o.sku,
    o.requested_by && `by ${o.requested_by}`,
    o.approval === 'approved' && o.approved_by && approvalRequired() ? `approved by ${o.approved_by}` : null,
    o.notes,
  ].filter(Boolean).join(' · ');
  const shipping = o.status !== 'needed' && (o.order_number || o.tracking_number)
    ? h('div', { class: 'part-sub ship' },
      o.order_number ? `Order ${o.order_number}` : null,
      o.order_number && o.tracking_number ? ' · ' : null,
      o.tracking_number ? ['Tracking ', trackingLink(o)] : null)
    : null;

  return h('tr', { class: o.approval === 'rejected' ? 'rejected' : o.approval === 'pending' ? 'pending' : '' },
    h('td', { class: 'thumb' }, o.image ? h('img', { src: o.image, alt: '', loading: 'lazy' }) : h('div', { class: 'thumb-ph' })),
    h('td', {},
      h('div', { class: 'part-name' }, o.url ? h('a', { href: o.url, target: '_blank', rel: 'noopener' }, o.name) : o.name),
      h('div', { class: 'part-sub' }, sub,
        o.priority && o.priority !== 'normal' ? [' ', h('span', { class: `pill prio-${o.priority}` }, o.priority)] : null),
      o.approval === 'rejected' && o.rejection_reason ? h('div', { class: 'part-sub reject-reason' }, `Rejected by ${o.approved_by}: ${o.rejection_reason}`) : null,
      shipping),
    h('td', { class: 'hide-sm' }, supplierPill(o.supplier)),
    h('td', { class: 'hide-sm' }, mechPill(o.mechanism_id)),
    h('td', { class: 'num' }, o.quantity),
    h('td', { class: 'num hide-sm hide-md' }, money(o.unit_price_cents)),
    h('td', { class: 'num' }, o.unit_price_cents == null ? '—' : money(lineTotal(o))),
    h('td', {}, stockPill(inventoryFor(o)) || h('span', { class: 'part-sub' }, '—')),
    h('td', {}, approvalCell(o)),
    h('td', { class: 'actions' },
      o.status !== 'arrived' && o.approval === 'approved'
        ? h('button', { class: 'btn small', title: 'Mark arrived and add to inventory', onclick: () => openReceiveModal(o) }, 'Receive') : null, ' ',
      h('button', { class: 'btn small', onclick: () => openItemModal('order', o) }, canEditOrder(o) ? 'Edit' : 'View'), ' ',
      canEditOrder(o) ? h('button', { class: 'btn small danger', title: 'Delete this part request', onclick: () => deleteOrder(o) }, 'Delete') : null),
  );
}

async function approve(ids) {
  await attempt(() => api('POST', '/api/orders/bulk-approve', { ids }), `Approved ${plural(ids.length, 'request')}`);
  refresh();
}

export function rejectRequest(o) {
  const reason = h('textarea', { rows: 3, placeholder: 'e.g. We have these in the spares bin / pick the 9.5mm version' });
  openModal('Reject request', h('div', { class: 'form' },
    h('div', { class: 'full' }, h('div', { class: 'part-name' }, o.name), h('div', { class: 'part-sub' }, `Requested by ${o.requested_by || 'unknown'}`)),
    field('Reason (shown to the requester)', reason, 'full')), [
    h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
    h('button', { class: 'btn danger', onclick: async () => {
      await attempt(() => api('POST', `/api/orders/${o.id}/reject`, { reason: reason.value }), 'Request rejected');
      closeModal();
      refresh();
    } }, 'Reject'),
  ], 'narrow');
  reason.focus();
}

async function deleteOrder(o) {
  if (!confirm(`Delete "${o.name}"? This cannot be undone.`)) return;
  const ok = await attempt(() => api('DELETE', `/api/orders/${o.id}`), 'Part removed');
  if (ok) refresh();
}

async function changeStatus(order, status) {
  if (status === 'arrived') return openReceiveModal(order);
  if (status === 'ordered') return openPlacedOrderModal([order.id]);
  await attempt(() => api('PATCH', `/api/orders/${order.id}`, { status }));
  refresh();
}

// Mark parts ordered and record the supplier's order number and tracking number.
export function openPlacedOrderModal(ids, supplierLabel) {
  const first = state.orders.find((o) => o.id === ids[0]);
  const orderNo = h('input', { type: 'text', placeholder: 'e.g. #104233', value: first?.order_number || '' });
  const tracking = h('input', { type: 'text', placeholder: 'Add now or later', value: first?.tracking_number || '' });
  const carrier = h('select', {}, h('option', { value: '' }, 'Detect automatically'), CARRIER_NAMES.map((c) => h('option', { value: c, selected: first?.carrier === c }, c)));
  const detected = h('span', { class: 'note' });
  tracking.addEventListener('input', () => {
    const c = detectCarrier(tracking.value);
    detected.textContent = c && !carrier.value ? `Looks like ${c}` : '';
  });
  openModal(`Mark ${plural(ids.length, 'part')} ordered`, h('div', { class: 'form' },
    h('p', { class: 'full note' }, `${supplierLabel ? `From ${supplierLabel}. ` : ''}Both fields are optional; you can add tracking later from the part's Edit screen or by selecting parts again.`),
    field('Supplier order #', orderNo),
    field('Carrier', carrier),
    field('Tracking #', tracking, 'full'),
    h('div', { class: 'full' }, detected)), [
    h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => {
      const res = await attempt(() => api('POST', '/api/orders/bulk-status', {
        ids, status: 'ordered', order_number: orderNo.value, tracking_number: tracking.value,
        carrier: carrier.value || detectCarrier(tracking.value) || '',
      }));
      if (!res) return;
      closeModal();
      toast(`Marked ${plural(ids.length - res.skipped, 'part')} ordered${res.skipped ? ` (${res.skipped} not approved yet)` : ''}`);
      refresh();
    } }, 'Mark ordered'),
  ], 'narrow');
  orderNo.focus();
}

export function openReceiveModal(order) {
  const match = inventoryFor(order);
  const qty = h('input', { type: 'number', min: 0, value: order.quantity });
  const loc = h('input', { type: 'text', placeholder: 'e.g. Bin 12, Shelf B', value: match.items[0]?.location || '' });
  openModal('Receive order', h('div', { class: 'form' },
    h('div', { class: 'full' }, h('div', { class: 'part-name' }, order.name), h('div', { class: 'part-sub' }, supplierName(order.supplier))),
    match.items.length
      ? h('div', { class: 'full ok-box' }, `Already tracking this in inventory (${match.qty} on hand). The received count will be added to it.`)
      : h('div', { class: 'full note' }, 'This creates a new inventory item.'),
    field('Quantity received', qty),
    field('Storage location', loc)),
  [
    isMentor() ? h('button', { class: 'btn', onclick: async () => {
      await attempt(() => api('PATCH', `/api/orders/${order.id}`, { status: 'arrived' }));
      closeModal();
      refresh();
    } }, 'Just mark arrived') : null,
    h('button', { class: 'btn primary', onclick: async () => {
      const ok = await attempt(() => api('POST', `/api/orders/${order.id}/receive`, { quantity: Number(qty.value) || 0, location: loc.value.trim() || null }), 'Added to inventory');
      if (!ok) return;
      closeModal();
      refresh();
    } }, 'Add to inventory'),
  ], 'narrow');
}
