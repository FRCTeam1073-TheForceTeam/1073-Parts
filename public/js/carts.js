// Carts tab + "Generate cart": fill a supplier's cart with every approved, needed part.
import {
  h, api, money, lineTotal, plural, toast, state, supplierByKey, groupItems,
  openModal, closeModal, isMentor, approvalRequired,
} from './core.js';
import { openPlacedOrderModal } from './orders.js';

// Can this order be put in the supplier's cart automatically?
export function cartable(s, o) {
  return { shopify: !!o.variant_id, bigcommerce: !!o.product_id, swyft: !!o.url, mcmaster: !!o.sku }[s.platform] ?? false;
}

export function renderCarts() {
  const needed = state.orders.filter((o) => o.status === 'needed' && o.approval !== 'rejected');
  if (!needed.length) return h('div', { class: 'empty' }, 'Nothing is marked "Needed" right now, so there are no carts to build.');
  const mentor = isMentor();

  return h('div', {},
    h('p', { class: 'note' }, mentor
      ? 'Every "Needed" part, grouped by supplier. "Generate cart" fills that supplier\'s cart on their website so you can check out there.'
      : 'Every "Needed" part, grouped by supplier. A mentor places the orders.'),
    h('div', { class: 'cards' }, groupItems(needed, 'supplier').map((g) => {
      const s = supplierByKey(g.key);
      const approved = g.items.filter((o) => o.approval === 'approved');
      const pending = g.items.filter((o) => o.approval === 'pending');
      const total = approved.reduce((n, o) => n + lineTotal(o), 0);
      const auto = s?.cartMode ? approved.filter((o) => cartable(s, o)) : [];
      const manual = approved.length - auto.length;
      return h('div', { class: 'card' },
        h('h3', {}, h('span', { class: 'dot', style: { background: g.color } }), g.label),
        h('div', { class: 'row' }, h('span', { class: 'total' }, money(total)), h('span', { class: 'note' }, plural(approved.length, 'line'))),
        h('ul', {}, g.items.map((o) => h('li', { class: o.approval === 'pending' ? 'muted' : '' },
          `${o.quantity} × ${o.name}${o.approval === 'pending' ? ' (awaiting approval)' : ''}`))),
        pending.length && approvalRequired() ? h('div', { class: 'note' }, `${pending.length} awaiting approval won't be added until a mentor approves them.`) : null,
        s?.cartMode && manual ? h('div', { class: 'warn-box' }, `${manual} part(s) were entered by hand and can't be added automatically.`) : null,
        mentor ? h('div', { class: 'row' },
          s?.cartMode ? h('button', { class: 'btn primary', disabled: !auto.length, onclick: () => generateCart(s.key, approved.map((o) => o.id)) }, 'Generate cart')
            : h('span', { class: 'note' }, 'No automatic cart for this supplier.'),
          approved.length ? h('button', { class: 'btn', onclick: () => openPlacedOrderModal(approved.map((o) => o.id), g.label) }, 'Mark all ordered…') : null) : null);
    })));
}

export async function generateCart(supplierKey, orderIds) {
  let cart;
  try {
    cart = await api('POST', '/api/cart', { supplier: supplierKey, orderIds });
  } catch (err) {
    return toast(err.message, true);
  }
  const s = supplierByKey(supplierKey);
  const added = cart.orderIds.filter((id) => !cart.skipped.some((x) => x.orderIds.includes(id)));
  const skippedBox = cart.skipped.length
    ? h('div', { class: 'warn-box' }, 'Not added (no supplier product link): ', cart.skipped.map((x) => x.name).join(', '), '. Add these on the website yourself.')
    : null;

  let body;
  if (cart.mode === 'permalink') {
    body = h('div', { class: 'steps' },
      h('p', {}, `Opens ${s.name} with ${plural(added.length, 'part')} in the cart.`),
      h('p', { class: 'note' }, `Heads up: this link replaces whatever is already in your ${s.name} cart on this browser.`),
      skippedBox,
      h('div', {}, h('a', { class: 'btn primary', href: cart.url, target: '_blank', rel: 'noopener' }, `Open ${s.name} cart ↗`)));
  } else if (cart.mode === 'paste') {
    const text = h('textarea', { rows: Math.min(12, cart.text.split('\n').length + 1), readonly: true, class: 'mono' }, cart.text);
    body = h('div', { class: 'steps' },
      h('p', {}, `${s.name} can't be filled by a link. Copy this list, open ${s.name}'s order page, click "Paste part numbers and quantities", and paste it there.`),
      text,
      skippedBox,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => {
          try {
            await navigator.clipboard.writeText(cart.text);
            toast('Copied');
          } catch {
            text.select();
            toast('Press Ctrl+C to copy');
          }
        } }, 'Copy list'),
        h('a', { class: 'btn', href: cart.cartUrl, target: '_blank', rel: 'noopener' }, `Open ${s.name} order page ↗`)));
  } else {
    const sequential = cart.mode === 'sequential';
    const steps = cart.steps.map((st) => {
      const row = h('div', { class: 'step' },
        h('span', { class: 'grow' }, `${st.quantity} × ${st.name}`),
        h('button', { class: 'btn small primary', onclick: () => {
          // Re-use one named tab so every add lands in the same session/cart.
          window.open(st.url, `${s.key}-cart`);
          row.classList.add('done');
        } }, sequential ? 'Add' : 'Open'));
      return row;
    });
    body = h('div', { class: 'steps' },
      h('p', {}, sequential
        ? `${s.name} only lets sites add one product at a time. Click "Add" on each line, in order; they all open in the same ${s.name} tab.`
        : `${s.name} doesn't support adding to the cart from another site. "Open" shows each product page in the same tab; pick the quantity and add it there.`),
      steps,
      skippedBox,
      h('div', {}, h('a', { class: 'btn', href: cart.cartUrl, target: `${s.key}-cart` }, `View ${s.name} cart ↗`)));
  }

  openModal(`Generate ${s.name} cart`, body, [
    h('button', { class: 'btn', onclick: closeModal }, 'Close'),
    added.length ? h('button', { class: 'btn primary', onclick: () => { closeModal(); openPlacedOrderModal(added, s.name); } }, 'I placed the order…') : null,
  ], 'narrow');
}
