// Board tab: a scrum/kanban board for custom parts (by manufacturing stage) and for COTS orders (by status).
import {
  h, api, money, plural, attempt, toast, prefs, state, supplierPill, mechById,
  render, refresh, seg, stat, rerenderKeepingFocus, isMentor, approvalRequired, personName,
  processList, initials, lineTotal,
} from './core.js';
import { openCustomPartModal } from './custom-modal.js';
import { openViewer, isViewable } from './viewer.js';
import { openItemModal } from './item-modal.js';
import { openPlacedOrderModal, openReceiveModal } from './orders.js';

const today = () => new Date().toISOString().slice(0, 10);
const isOverdue = (p, lastColumnId) => p.due_date && p.due_date < today() && p.column_id !== lastColumnId;

function setUi(key, value, persist = false) {
  state.ui[key] = value;
  if (persist) prefs.set(key, value);
  render();
}

function filteredCustom() {
  const { boardMech, boardPerson, boardProcess, boardQuery } = state.ui;
  const q = boardQuery.trim().toLowerCase();
  return state.customParts.filter((p) => {
    if (boardMech && String(p.mechanism_id ?? 'none') !== boardMech) return false;
    if (boardPerson === 'me' && p.assigned_to !== state.user.id) return false;
    if (boardPerson === 'nobody' && p.assigned_to) return false;
    if (boardPerson && !['me', 'nobody'].includes(boardPerson) && String(p.assigned_to) !== boardPerson) return false;
    if (boardProcess && (p.process || '') !== boardProcess) return false;
    if (q && ![p.name, p.part_number, p.material, p.notes, personName(p.assigned_to)].some((f) => (f || '').toLowerCase().includes(q))) return false;
    return true;
  });
}

export function renderBoard() {
  const ui = state.ui;
  const custom = ui.boardMode === 'custom';

  const toolbar = h('div', { class: 'toolbar' },
    seg([['custom', 'Manufacturing'], ['cots', 'COTS orders']], ui.boardMode, (v) => setUi('boardMode', v, true)),
    custom ? seg([['board', 'Board'], ['list', 'List']], ui.boardView, (v) => setUi('boardView', v, true)) : null,
    h('input', { type: 'search', placeholder: 'Filter…', value: ui.boardQuery, oninput: (e) => { ui.boardQuery = e.target.value; rerenderKeepingFocus(e.target); } }),
    h('select', { 'aria-label': 'Mechanism', onchange: (e) => setUi('boardMech', e.target.value) },
      h('option', { value: '' }, 'All mechanisms'),
      state.mechanisms.map((m) => h('option', { value: String(m.id), selected: ui.boardMech === String(m.id) }, m.name)),
      h('option', { value: 'none', selected: ui.boardMech === 'none' }, 'Unassigned')),
    custom ? h('select', { 'aria-label': 'Person', onchange: (e) => setUi('boardPerson', e.target.value) },
      h('option', { value: '' }, 'Everyone'),
      h('option', { value: 'me', selected: ui.boardPerson === 'me' }, 'Assigned to me'),
      h('option', { value: 'nobody', selected: ui.boardPerson === 'nobody' }, 'Not assigned'),
      state.team.map((u) => h('option', { value: String(u.id), selected: ui.boardPerson === String(u.id) }, u.display_name))) : null,
    custom ? h('select', { 'aria-label': 'Process', onchange: (e) => setUi('boardProcess', e.target.value) },
      h('option', { value: '' }, 'All processes'),
      [...new Set([...processList(), ...state.customParts.map((p) => p.process).filter(Boolean)])]
        .map((p) => h('option', { value: p, selected: ui.boardProcess === p }, p))) : null,
    h('div', { class: 'grow' }),
    custom ? h('button', { class: 'btn primary', onclick: () => openCustomPartModal(null, { mechanism_id: ui.boardMech && ui.boardMech !== 'none' ? Number(ui.boardMech) : null }) }, '+ Custom part')
      : h('button', { class: 'btn primary', onclick: () => openItemModal('order') }, '+ Add part'),
  );

  if (!custom) return h('div', {}, toolbar, cotsBoard());

  const parts = filteredCustom();
  const last = state.columns.at(-1)?.id;
  const done = state.customParts.filter((p) => p.column_id === last).length;
  const stats = h('div', { class: 'stats' },
    stat('Custom parts', state.customParts.length),
    stat('In progress', state.customParts.filter((p) => p.started_at && p.column_id !== last).length),
    stat('Done', state.customParts.length ? `${done} (${Math.round((done / state.customParts.length) * 100)}%)` : '0'),
    stat('Overdue', state.customParts.filter((p) => isOverdue(p, last)).length, state.customParts.some((p) => isOverdue(p, last)) ? 'bad' : ''));

  if (!state.customParts.length) {
    return h('div', {}, stats, toolbar, h('div', { class: 'empty' },
      'No custom parts yet. Click "+ Custom part", or use "Import BOM" on the Orders tab: rows that aren\'t supplier parts can go straight onto this board.'));
  }
  return h('div', {}, stats, toolbar, ui.boardView === 'list' ? customList(parts) : customBoard(parts));
}

// ---------------------------------------------------------------------------
// Kanban mechanics shared by both boards

let dragging = null; // { id, kind }

function makeColumn({ id, name, color, cards, onDrop, footer, canDrop = true }) {
  const list = h('div', { class: 'kcards', 'data-col': id });
  list.append(...cards);
  if (canDrop) {
    list.addEventListener('dragover', (e) => {
      if (!dragging) return;
      e.preventDefault();
      list.classList.add('over');
      const after = [...list.querySelectorAll('.kcard:not(.dragging)')].find((c) => e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2);
      let ph = list.querySelector('.kplaceholder') || h('div', { class: 'kplaceholder' });
      if (after) list.insertBefore(ph, after);
      else list.append(ph);
    });
    list.addEventListener('dragleave', (e) => {
      if (!list.contains(e.relatedTarget)) {
        list.classList.remove('over');
        list.querySelector('.kplaceholder')?.remove();
      }
    });
    list.addEventListener('drop', (e) => {
      e.preventDefault();
      const ph = list.querySelector('.kplaceholder');
      const before = ph?.nextElementSibling?.classList.contains('kcard') ? Number(ph.nextElementSibling.dataset.id) : null;
      ph?.remove();
      list.classList.remove('over');
      if (dragging) onDrop(dragging.id, before);
      dragging = null;
    });
  }
  return h('section', { class: 'kcol' },
    h('header', { class: 'kcol-head' }, h('span', { class: 'dot', style: { background: color } }), h('span', { class: 'kcol-name' }, name),
      h('span', { class: 'kcount' }, cards.length)),
    list,
    footer || null);
}

function makeCard(id, kind, draggable, onOpen, children) {
  const card = h('article', { class: 'kcard', 'data-id': id, draggable: draggable ? 'true' : null, tabindex: 0, onclick: onOpen,
    onkeydown: (e) => { if (e.key === 'Enter') onOpen(); } }, children);
  if (draggable) {
    card.addEventListener('dragstart', (e) => {
      dragging = { id, kind };
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(id));
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      document.querySelectorAll('.kplaceholder').forEach((p) => p.remove());
      document.querySelectorAll('.kcards.over').forEach((l) => l.classList.remove('over'));
      dragging = null;
    });
  }
  return card;
}

// ---------------------------------------------------------------------------
// Manufacturing board

async function moveCustom(id, columnId, beforeId) {
  const part = state.customParts.find((p) => p.id === id);
  if (!part) return;
  const updated = await attempt(() => api('POST', `/api/custom-parts/${id}/move`, { column_id: columnId, before_id: beforeId }));
  if (!updated) return refresh();
  Object.assign(part, updated);
  state.customParts.sort((a, b) => a.sort - b.sort || a.id - b.id);
  render();
}

function customCard(p, colIndex) {
  const m = mechById(p.mechanism_id);
  const last = state.columns.at(-1)?.id;
  const next = state.columns[colIndex + 1];
  const who = personName(p.assigned_to);
  const pct = Math.min(100, Math.round(((p.quantity_done || 0) / Math.max(1, p.quantity)) * 100));
  return makeCard(p.id, 'custom', true, () => openCustomPartModal(p), [
    p.image ? h('img', { class: 'kcard-img', src: p.image, alt: '', loading: 'lazy', draggable: 'false' }) : null,
    h('div', { class: 'kcard-top' },
      m ? h('span', { class: 'kmech', style: { background: m.color }, title: m.name }) : null,
      h('span', { class: 'kcard-title' }, p.name),
      p.priority && p.priority !== 'normal' ? h('span', { class: `pill prio-${p.priority}` }, p.priority) : null),
    p.part_number || p.material ? h('div', { class: 'part-sub' }, [p.part_number, p.material].filter(Boolean).join(' · ')) : null,
    h('div', { class: 'kprogress', title: `${p.quantity_done || 0} of ${p.quantity} made` },
      h('div', { class: 'kbar' }, h('div', { style: { width: pct + '%' } })),
      h('span', {}, `${p.quantity_done || 0}/${p.quantity}`)),
    h('div', { class: 'kcard-foot' },
      p.process ? h('span', { class: 'pill' }, p.process) : null,
      p.due_date ? h('span', { class: 'kdue' + (isOverdue(p, last) ? ' overdue' : '') }, `Due ${new Date(p.due_date + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`) : null,
      h('span', { class: 'grow' }),
      p.cad_url ? h('a', { class: 'kcad', href: p.cad_url, target: '_blank', rel: 'noopener', title: 'Open CAD', onclick: (e) => e.stopPropagation() }, 'CAD') : null,
      p.files?.some((f) => isViewable(f.name))
        ? h('button', { class: 'kfile', title: 'View in 3D', onclick: (e) => { e.stopPropagation(); openViewer(p.files.find((f) => isViewable(f.name)), p); } }, '3D')
        : null,
      p.files?.length ? h('span', { class: 'kfile', title: p.files.map((f) => f.name).join('\n') }, `📎 ${p.files.length}`) : null,
      who ? h('span', { class: 'avatar', title: `Assigned to ${who}` }, initials(who)) : null,
      next ? h('button', { class: 'knext', title: `Move to ${next.name}`, 'aria-label': `Move to ${next.name}`,
        onclick: (e) => { e.stopPropagation(); moveCustom(p.id, next.id, null); } }, '›') : null),
  ]);
}

function customBoard(parts) {
  return h('div', { class: 'kboard' }, state.columns.map((c, i) => {
    const cards = parts.filter((p) => p.column_id === c.id || (!p.column_id && i === 0)).map((p) => customCard(p, i));
    return makeColumn({
      id: c.id, name: c.name, color: c.color, cards,
      onDrop: (id, before) => moveCustom(id, c.id, before),
      footer: i === 0 ? h('button', { class: 'kadd', onclick: () => openCustomPartModal(null, { column_id: c.id }) }, '+ Add') : null,
    });
  }));
}

function customList(parts) {
  return state.columns.map((c, i) => {
    const rows = parts.filter((p) => p.column_id === c.id || (!p.column_id && i === 0));
    if (!rows.length) return null;
    return h('section', { class: 'group' },
      h('div', { class: 'group-head' }, h('h3', {}, h('span', { class: 'dot', style: { background: c.color } }), c.name), h('span', { class: 'meta' }, plural(rows.length, 'part'))),
      h('table', { class: 'plain board-list' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Part'), h('th', {}, 'Mechanism'), h('th', {}, 'Process'), h('th', {}, 'Material'),
          h('th', { class: 'num' }, 'Made'), h('th', {}, 'Assigned'), h('th', {}, 'Due'), h('th', {}, 'Stage'))),
        h('tbody', {}, rows.map((p) => h('tr', {},
          h('td', {}, h('button', { class: 'linkish part-name', onclick: () => openCustomPartModal(p) }, p.name), p.part_number ? h('div', { class: 'part-sub' }, p.part_number) : null),
          h('td', {}, mechById(p.mechanism_id)?.name || '—'),
          h('td', {}, p.process || '—'),
          h('td', {}, p.material || '—', p.files?.length ? h('span', { class: 'part-sub', title: p.files.map((f) => f.name).join('\n') }, ` · 📎 ${p.files.length}`) : null),
          h('td', { class: 'num' }, `${p.quantity_done || 0}/${p.quantity}`),
          h('td', {}, personName(p.assigned_to) || '—'),
          h('td', { class: isOverdue(p, state.columns.at(-1)?.id) ? 'overdue' : '' }, p.due_date || '—'),
          h('td', {}, h('select', { 'aria-label': 'Stage', onchange: (e) => moveCustom(p.id, Number(e.target.value), null) },
            state.columns.map((col) => h('option', { value: col.id, selected: col.id === c.id }, col.name)))))))));
  });
}

// ---------------------------------------------------------------------------
// COTS board: purchased parts by order status. Mentors drag cards to change status.

const COTS_COLUMNS = [
  { id: 'pending', name: 'Awaiting approval', color: 'var(--warn)' },
  { id: 'needed', name: 'Needed', color: 'var(--needed)' },
  { id: 'ordered', name: 'Ordered', color: 'var(--ordered)' },
  { id: 'arrived', name: 'Arrived (last 2 weeks)', color: 'var(--arrived)' },
];

function cotsColumnOf(o) {
  if (o.approval === 'pending') return 'pending';
  return o.status;
}

async function moveCots(id, target) {
  const o = state.orders.find((x) => x.id === id);
  if (!o || cotsColumnOf(o) === target) return;
  if (target === 'pending') return toast('Requests go to approval when a student submits them.', true);
  if (o.approval === 'pending' && target !== 'needed') return toast('Approve this request first.', true);
  if (o.approval === 'pending' && target === 'needed') {
    await attempt(() => api('POST', '/api/orders/bulk-approve', { ids: [id] }), 'Approved');
    return refresh();
  }
  if (target === 'ordered') return openPlacedOrderModal([id]);
  if (target === 'arrived') return openReceiveModal(o);
  await attempt(() => api('PATCH', `/api/orders/${id}`, { status: target }));
  refresh();
}

function cotsBoard() {
  const { boardMech, boardQuery } = state.ui;
  const q = boardQuery.trim().toLowerCase();
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const orders = state.orders.filter((o) => {
    if (o.approval === 'rejected') return false;
    if (o.status === 'arrived' && (o.arrived_at || '') < cutoff) return false;
    if (boardMech && String(o.mechanism_id ?? 'none') !== boardMech) return false;
    if (q && ![o.name, o.sku, o.requested_by].some((f) => (f || '').toLowerCase().includes(q))) return false;
    return true;
  });
  const cols = COTS_COLUMNS.filter((c) => c.id !== 'pending' || approvalRequired() || orders.some((o) => o.approval === 'pending'));
  const mentor = isMentor();
  return h('div', {},
    mentor ? null : h('p', { class: 'note' }, 'Mentors move purchased parts between columns as they are ordered and arrive.'),
    h('div', { class: 'kboard' }, cols.map((c) => makeColumn({
      id: c.id, name: c.name, color: c.color, canDrop: mentor,
      onDrop: (id) => moveCots(id, c.id),
      cards: orders.filter((o) => cotsColumnOf(o) === c.id).map((o) => makeCard(o.id, 'cots', mentor, () => openItemModal('order', o), [
        h('div', { class: 'kcard-top' },
          mechById(o.mechanism_id) ? h('span', { class: 'kmech', style: { background: mechById(o.mechanism_id).color } }) : null,
          h('span', { class: 'kcard-title' }, o.name)),
        h('div', { class: 'part-sub' }, `${o.quantity} × ${money(o.unit_price_cents)} = ${money(lineTotal(o))}`),
        h('div', { class: 'kcard-foot' }, supplierPill(o.supplier), h('span', { class: 'grow' }),
          o.tracking_number ? h('span', { class: 'part-sub' }, 'tracking') : null,
          o.requested_by ? h('span', { class: 'avatar', title: `Requested by ${o.requested_by}` }, initials(o.requested_by)) : null),
      ])),
    }))));
}

