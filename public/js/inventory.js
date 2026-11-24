// Inventory tab: what's on the shelf, minimums, and restocking.
import {
  h, api, money, plural, attempt, toast, prefs, state, supplierName, supplierPill, mechById,
  isLowStock, openOrdersFor, openModal, closeModal, refresh, render, seg, groupItems,
  rerenderKeepingFocus, stat, STATUS_LABEL,
} from './core.js';
import { openItemModal } from './item-modal.js';

export function renderInventory() {
  const ui = state.ui;
  const q = ui.invQuery.trim().toLowerCase();
  const items = state.inventory.filter((i) =>
    (!ui.invLowOnly || isLowStock(i)) &&
    (!q || [i.name, i.sku, i.location, i.notes, supplierName(i.supplier)].some((f) => (f || '').toLowerCase().includes(q))));
  const totalValue = state.inventory.reduce((n, i) => n + (i.unit_price_cents || 0) * i.quantity, 0);
  const low = state.inventory.filter(isLowStock);
  const lowNotOrdered = low.filter((i) => !openOrdersFor(i).length);

  const toolbar = h('div', { class: 'toolbar' },
    h('input', { type: 'search', placeholder: 'Search inventory…', value: ui.invQuery, oninput: (e) => { ui.invQuery = e.target.value; rerenderKeepingFocus(e.target); } }),
    h('label', { class: 'check-label' },
      h('input', { type: 'checkbox', checked: ui.invLowOnly, onchange: (e) => { ui.invLowOnly = e.target.checked; render(); } }),
      `Below minimum only (${low.length})`),
    h('div', { class: 'grow' }),
    h('span', { class: 'label' }, 'Group'),
    seg([['none', 'None'], ['mechanism', 'Mechanism'], ['supplier', 'Supplier'], ['location', 'Location']], ui.invGroup, (v) => {
      ui.invGroup = v;
      prefs.set('invGroup', v);
      render();
    }),
    lowNotOrdered.length ? h('button', { class: 'btn', onclick: () => openReorderModal() }, `Reorder low stock (${lowNotOrdered.length})`) : null,
    h('button', { class: 'btn primary', onclick: () => openItemModal('inventory') }, '+ Add to inventory'),
  );

  const stats = h('div', { class: 'stats' },
    stat('Unique items', state.inventory.length),
    stat('Total pieces', state.inventory.reduce((n, i) => n + i.quantity, 0)),
    stat('Below minimum', low.length, low.length ? 'attn' : ''),
    stat('Approx. value', money(totalValue)),
  );

  const body = items.length
    ? groupItems(items, ui.invGroup).map((g) => h('section', { class: 'group' },
      g.label == null ? null : h('div', { class: 'group-head' },
        h('h3', {}, h('span', { class: 'dot', style: { background: g.color } }), g.label),
        h('span', { class: 'meta' }, plural(g.items.length, 'item'))),
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', { class: 'w-thumb' }), h('th', {}, 'Item'), h('th', { class: 'hide-sm w-sup' }, 'Supplier'),
          h('th', { class: 'hide-sm w-mech' }, 'Location'), h('th', { class: 'num w-onhand' }, 'On hand'), h('th', { class: 'num w-qty hide-sm' }, 'Min'),
          h('th', { class: 'w-open' }, 'Open orders'), h('th', { class: 'w-edit' }))),
        h('tbody', {}, g.items.map(inventoryRow)))))
    : h('div', { class: 'empty' }, state.inventory.length ? 'Nothing matches.' : 'Inventory is empty. Add what\'s on the shelf, or use "Receive" on an order when it arrives.');

  return h('div', {}, stats, toolbar, body);
}

function inventoryRow(i) {
  const open = openOrdersFor(i);
  const low = isLowStock(i);
  const bump = async (delta) => {
    const quantity = Math.max(0, i.quantity + delta);
    const ok = await attempt(() => api('PATCH', `/api/inventory/${i.id}`, { quantity }));
    if (!ok) return;
    i.quantity = quantity;
    render();
  };
  return h('tr', { class: low ? 'low' : '' },
    h('td', { class: 'thumb' }, i.image ? h('img', { src: i.image, alt: '', loading: 'lazy' }) : h('div', { class: 'thumb-ph' })),
    h('td', {},
      h('div', { class: 'part-name' }, i.url ? h('a', { href: i.url, target: '_blank', rel: 'noopener' }, i.name) : i.name,
        low ? [' ', h('span', { class: 'pill low-pill' }, 'Low')] : null),
      h('div', { class: 'part-sub' }, [i.sku, mechById(i.mechanism_id)?.name, i.notes].filter(Boolean).join(' · '))),
    h('td', { class: 'hide-sm' }, supplierPill(i.supplier)),
    h('td', { class: 'hide-sm' }, i.location || '—'),
    h('td', { class: 'num' }, h('span', { class: 'qty-ctl' },
      h('button', { class: 'btn icon small', onclick: () => bump(-1), title: 'Use one', 'aria-label': 'Use one' }, '−'),
      h('span', { class: 'n' + (i.quantity <= 0 ? ' zero' : low ? ' lowq' : '') }, i.quantity),
      h('button', { class: 'btn icon small', onclick: () => bump(1), title: 'Add one', 'aria-label': 'Add one' }, '+'))),
    h('td', { class: 'num hide-sm' }, i.min_quantity || '—'),
    h('td', {}, open.length
      ? open.map((o) => h('span', { class: 'pill', title: o.name }, `${o.quantity} ${o.approval === 'pending' ? 'awaiting approval' : STATUS_LABEL[o.status].toLowerCase()}`))
      : h('button', { class: 'btn small', onclick: () => openItemModal('order', null, i) }, 'Order more')),
    h('td', { class: 'actions' }, h('button', { class: 'btn small', onclick: () => openItemModal('inventory', i) }, 'Edit')));
}

// Review everything below its minimum and create part requests in one go.
export function openReorderModal() {
  const low = state.inventory.filter((i) => isLowStock(i) && !openOrdersFor(i).length);
  if (!low.length) return;
  const rows = low.map((i) => {
    const check = h('input', { type: 'checkbox', checked: true, 'aria-label': `Reorder ${i.name}` });
    const qty = h('input', { type: 'number', min: 1, value: Math.max(1, i.min_quantity - i.quantity), class: 'qty-input' });
    return { i, check, qty, el: h('tr', {},
      h('td', { class: 'check' }, check),
      h('td', {}, h('div', { class: 'part-name' }, i.name), h('div', { class: 'part-sub' }, `${supplierName(i.supplier)}${i.sku ? ' · ' + i.sku : ''}`)),
      h('td', { class: 'num' }, `${i.quantity} / ${i.min_quantity}`),
      h('td', { class: 'num' }, qty),
      h('td', { class: 'num' }, money(i.unit_price_cents))) };
  });

  openModal('Reorder low stock', h('div', {},
    h('p', { class: 'note' }, 'These items are below their minimum and nobody has requested more yet. The suggested quantity brings each back up to its minimum.'),
    h('table', { class: 'plain' },
      h('thead', {}, h('tr', {}, h('th', { class: 'check' }), h('th', {}, 'Item'), h('th', { class: 'num' }, 'Have / min'), h('th', { class: 'num' }, 'Order'), h('th', { class: 'num' }, 'Each'))),
      h('tbody', {}, rows.map((r) => r.el)))), [
    h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => {
      const items = rows.filter((r) => r.check.checked).map((r) => ({ id: r.i.id, quantity: Number(r.qty.value) || 0 }));
      if (!items.length) return closeModal();
      const created = await attempt(() => api('POST', '/api/inventory/reorder', { items }));
      if (!created) return;
      closeModal();
      const pending = created.filter((o) => o.approval === 'pending').length;
      toast(`Created ${plural(created.length, 'part request')}${pending ? ` (${pending} awaiting approval)` : ''}`);
      state.view = 'orders';
      refresh();
    } }, 'Create requests'),
  ]);
}

