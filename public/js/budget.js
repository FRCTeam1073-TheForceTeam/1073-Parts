// Budget tab: season budget vs. spent / committed, by mechanism, supplier and month.
import {
  h, api, money, toCents, fromCents, lineTotal, attempt, state, supplierName, supplierByKey,
  mechById, refresh, stat, isMentor, openModal, closeModal, field,
} from './core.js';

// Spent = ordered or arrived. Committed = approved but not ordered yet. Pending = awaiting approval.
export function bucket(list) {
  const out = { spent: 0, committed: 0, pending: 0 };
  for (const o of list) {
    if (o.approval === 'rejected') continue;
    const t = lineTotal(o);
    if (o.approval === 'pending') out.pending += t;
    else if (o.status === 'needed') out.committed += t;
    else out.spent += t;
  }
  return out;
}

// One horizontal meter: spent (solid) + committed (light), scaled to `scale`.
function meter(b, scale, budget) {
  const pct = (v) => (scale > 0 ? Math.min(100, (v / scale) * 100) : 0);
  return h('div', { class: 'meter', role: 'img', 'aria-label': `Spent ${money(b.spent)}, committed ${money(b.committed)}${budget != null ? ` of ${money(budget)}` : ''}` },
    h('div', { class: 'meter-seg spent', style: { width: pct(b.spent) + '%' }, title: `Spent ${money(b.spent)}` }),
    h('div', { class: 'meter-seg committed', style: { width: pct(b.committed) + '%' }, title: `Committed ${money(b.committed)}` }),
    budget != null ? h('div', { class: 'meter-mark', style: { left: pct(budget) + '%' }, title: `Budget ${money(budget)}` }) : null);
}

const legend = () => h('div', { class: 'legend' },
  h('span', {}, h('i', { class: 'sw spent' }), 'Spent (ordered or arrived)'),
  h('span', {}, h('i', { class: 'sw committed' }), 'Committed (approved, not ordered)'),
  h('span', {}, h('i', { class: 'sw mark' }), 'Budget'));

function breakdownTable(rows, { withBudget = false, onEditBudget } = {}) {
  const scale = Math.max(1, ...rows.map((r) => Math.max(r.spent + r.committed, r.budget || 0)));
  return h('table', { class: 'plain budget-table' },
    h('thead', {}, h('tr', {},
      h('th', {}, rows.label || ''), h('th', { class: 'num' }, 'Spent'), h('th', { class: 'num' }, 'Committed'),
      withBudget ? h('th', { class: 'num' }, 'Budget') : null, withBudget ? h('th', { class: 'num' }, 'Left') : null,
      h('th', { class: 'meter-col' }))),
    h('tbody', {}, rows.map((r) => {
      const left = r.budget != null ? r.budget - r.spent - r.committed : null;
      return h('tr', {},
        h('td', {}, h('span', { class: 'dot', style: { background: r.color } }), ' ', r.name),
        h('td', { class: 'num' }, money(r.spent)),
        h('td', { class: 'num' }, money(r.committed)),
        withBudget ? h('td', { class: 'num' }, onEditBudget && r.id
          ? h('button', { class: 'linkish', onclick: () => onEditBudget(r) }, r.budget != null ? money(r.budget) : 'Set')
          : money(r.budget)) : null,
        withBudget ? h('td', { class: 'num' + (left != null && left < 0 ? ' over' : '') }, left == null ? '—' : left < 0 ? `Over ${money(-left)}` : money(left)) : null,
        h('td', { class: 'meter-col' }, meter(r, scale, r.budget)));
    })));
}

function editMechBudget(m) {
  const input = h('input', { type: 'number', min: 0, step: '1', value: fromCents(m.budget), placeholder: 'No budget' });
  openModal(`${m.name} budget`, field('Budget ($), leave empty for none', input), [
    h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => {
      await attempt(() => api('PATCH', `/api/mechanisms/${m.id}`, { budget_cents: toCents(input.value) }), 'Saved');
      closeModal();
      refresh();
    } }, 'Save'),
  ], 'narrow');
  input.focus();
}

function editSeasonBudget() {
  const name = h('input', { type: 'text', value: state.settings.season_name });
  const amount = h('input', { type: 'number', min: 0, step: '1', value: fromCents(state.settings.season_budget_cents) });
  openModal('Season budget', h('div', { class: 'form' }, field('Season', name), field('Total budget ($)', amount)), [
    h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => {
      await attempt(() => api('PUT', '/api/settings', { season_name: name.value.trim(), season_budget_cents: toCents(amount.value) ?? '' }), 'Saved');
      closeModal();
      refresh();
    } }, 'Save'),
  ], 'narrow');
  amount.focus();
}

export function renderBudget() {
  const mentor = isMentor();
  const all = bucket(state.orders);
  const budget = state.settings.season_budget_cents === '' ? null : Number(state.settings.season_budget_cents);
  const left = budget != null ? budget - all.spent - all.committed : null;

  const head = h('div', { class: 'toolbar' },
    h('h2', { class: 'page-title' }, state.settings.season_name || 'Season'),
    h('div', { class: 'grow' }),
    mentor ? h('button', { class: 'btn', onclick: editSeasonBudget }, budget == null ? 'Set season budget' : 'Edit season budget') : null);

  const stats = h('div', { class: 'stats' },
    stat('Season budget', budget == null ? 'Not set' : money(budget)),
    stat('Spent', money(all.spent)),
    stat('Committed', money(all.committed)),
    budget != null
      ? stat(left < 0 ? 'Over budget' : 'Left to spend', money(Math.abs(left)), left < 0 ? 'bad' : '')
      : stat('Awaiting approval', money(all.pending)));

  const overall = budget != null ? h('section', { class: 'card' },
    h('div', { class: 'row between' },
      h('strong', {}, `${Math.round(((all.spent + all.committed) / Math.max(budget, 1)) * 100)}% of budget used or committed`),
      all.pending ? h('span', { class: 'note' }, `${money(all.pending)} more awaiting approval`) : null),
    meter(all, Math.max(budget, all.spent + all.committed), budget),
    legend()) : null;

  const mechRows = [
    ...state.mechanisms.map((m) => ({ id: m.id, name: m.name, color: m.color, budget: m.budget_cents ?? null, ...bucket(state.orders.filter((o) => o.mechanism_id === m.id)) })),
    { name: 'Unassigned', color: '#94a3b8', budget: null, ...bucket(state.orders.filter((o) => !mechById(o.mechanism_id))) },
  ].filter((r) => r.spent || r.committed || r.budget != null || r.id);

  const supplierKeys = [...new Set(state.orders.map((o) => o.supplier || ''))];
  const supRows = supplierKeys.map((k) => ({ name: k ? supplierName(k) : 'No supplier', color: supplierByKey(k)?.color || '#94a3b8', budget: null, ...bucket(state.orders.filter((o) => (o.supplier || '') === k)) }))
    .filter((r) => r.spent || r.committed)
    .sort((a, b) => b.spent + b.committed - (a.spent + a.committed));

  // Spending per month, from when parts were marked ordered.
  const months = new Map();
  for (const o of state.orders) {
    if (o.approval === 'rejected' || o.status === 'needed' || !o.ordered_at) continue;
    const key = o.ordered_at.slice(0, 7);
    months.set(key, (months.get(key) || 0) + lineTotal(o));
  }
  const monthRows = [...months].sort(([a], [b]) => a.localeCompare(b));
  const maxMonth = Math.max(1, ...monthRows.map(([, v]) => v));
  const monthLabel = (k) => new Date(k + '-15').toLocaleDateString(undefined, { month: 'short', year: '2-digit' });

  const monthly = monthRows.length ? h('section', { class: 'card' },
    h('h3', {}, 'Spending by month'),
    h('div', { class: 'month-chart', role: 'img', 'aria-label': 'Spending by month' }, monthRows.map(([k, v]) =>
      h('div', { class: 'month-col', title: `${monthLabel(k)}: ${money(v)}` },
        h('div', { class: 'month-val' }, money(v).replace(/\.\d\d$/, '')),
        h('div', { class: 'month-bar-wrap' }, h('div', { class: 'month-bar', style: { height: `${(v / maxMonth) * 100}%` } })),
        h('div', { class: 'month-label' }, monthLabel(k)))))) : null;

  if (!state.orders.length) {
    return h('div', {}, head, stats, h('div', { class: 'empty' }, 'No orders yet. Spending shows up here as parts are requested and ordered.'));
  }

  return h('div', { class: 'budget' }, head, stats, overall,
    h('section', { class: 'card' }, h('div', { class: 'row between' }, h('h3', {}, 'By mechanism'),
      mentor ? h('span', { class: 'note' }, 'Click a budget to change it.') : null),
    breakdownTable(Object.assign(mechRows, { label: 'Mechanism' }), { withBudget: true, onEditBudget: mentor ? editMechBudget : null }), budget == null ? legend() : null),
    h('section', { class: 'card' }, h('h3', {}, 'By supplier'), breakdownTable(Object.assign(supRows, { label: 'Supplier' }))),
    monthly);
}
