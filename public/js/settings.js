// Settings tab: your account, team members, approval rules, mechanisms, suppliers.
import {
  h, api, money, toCents, fromCents, attempt, state, ROLE_LABEL, refresh, can, isMentor,
  openModal, closeModal, field, toast, prefs, setTheme, seg, render,
} from './core.js';

function accountCard() {
  const name = h('input', { type: 'text', value: state.user.display_name });
  const current = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'At least 8 characters' });
  return h('div', { class: 'card' },
    h('h3', {}, 'My account'),
    h('p', { class: 'note' }, `Signed in as ${state.user.username} · ${ROLE_LABEL[state.user.role]}`),
    h('div', { class: 'form' },
      field('Display name', name, 'full'),
      field('Current password', current),
      field('New password', next)),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => {
      const body = { display_name: name.value.trim() };
      if (next.value) Object.assign(body, { current_password: current.value, new_password: next.value });
      const ok = await attempt(() => api('PATCH', '/api/me', body), next.value ? 'Password changed' : 'Saved');
      if (ok) refresh();
    } }, 'Save')));
}

function userRow(u) {
  const self = u.id === state.user.id;
  const role = h('select', { disabled: self, 'aria-label': 'Role', onchange: (e) => attempt(() => api('PATCH', `/api/users/${u.id}`, { role: e.target.value }), 'Role updated').then(refresh) },
    Object.entries(ROLE_LABEL).map(([v, l]) => h('option', { value: v, selected: u.role === v }, l)));
  return h('tr', { class: u.disabled ? 'muted' : '' },
    h('td', {}, h('div', { class: 'part-name' }, u.display_name, self ? ' (you)' : ''), h('div', { class: 'part-sub' }, u.username)),
    h('td', {}, can('admin') ? role : ROLE_LABEL[u.role]),
    h('td', { class: 'actions' }, can('admin') && !self ? [
      h('button', { class: 'btn small', onclick: () => resetPassword(u) }, 'Reset password'), ' ',
      h('button', { class: 'btn small', onclick: () => attempt(() => api('PATCH', `/api/users/${u.id}`, { disabled: !u.disabled }), u.disabled ? 'Re-enabled' : 'Disabled').then(refresh) },
        u.disabled ? 'Enable' : 'Disable'), ' ',
      h('button', { class: 'btn small danger', onclick: async () => {
        if (!confirm(`Delete ${u.display_name}'s account? Their part requests stay.`)) return;
        await attempt(() => api('DELETE', `/api/users/${u.id}`), 'Account deleted');
        refresh();
      } }, 'Delete'),
    ] : null));
}

function resetPassword(u) {
  const pw = h('input', { type: 'text', placeholder: 'At least 8 characters', autocomplete: 'off' });
  openModal(`New password for ${u.display_name}`, h('div', {},
    field('Temporary password', pw),
    h('p', { class: 'note' }, 'Give it to them in person; they can change it under Settings → My account. This signs them out everywhere.')), [
    h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => {
      const ok = await attempt(() => api('PATCH', `/api/users/${u.id}`, { password: pw.value }), 'Password reset');
      if (ok) closeModal();
    } }, 'Set password'),
  ], 'narrow');
  pw.focus();
}

function addUserModal() {
  const display = h('input', { type: 'text', placeholder: 'e.g. Jordan Lee' });
  const username = h('input', { type: 'text', placeholder: 'e.g. jlee', autocomplete: 'off' });
  const pw = h('input', { type: 'text', placeholder: 'At least 8 characters', autocomplete: 'off' });
  const role = h('select', {}, Object.entries(ROLE_LABEL).map(([v, l]) => h('option', { value: v }, l)));
  display.addEventListener('input', () => {
    if (!username.dataset.touched) username.value = display.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
  });
  username.addEventListener('input', () => (username.dataset.touched = '1'));
  openModal('Add team member', h('div', { class: 'form' },
    field('Name', display), field('Username', username), field('Temporary password', pw), field('Role', role),
    h('p', { class: 'full note' }, 'Students can request parts and update inventory. Mentors also approve requests, place orders and manage budgets. Admins also manage accounts.')), [
    h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => {
      const ok = await attempt(() => api('POST', '/api/users', { display_name: display.value, username: username.value, password: pw.value, role: role.value }), 'Account created');
      if (!ok) return;
      closeModal();
      refresh();
    } }, 'Create account'),
  ], 'narrow');
  display.focus();
}

function teamCard() {
  return h('div', { class: 'card wide' },
    h('div', { class: 'row between' }, h('h3', {}, 'Team members'),
      can('admin') ? h('button', { class: 'btn primary small', onclick: addUserModal }, '+ Add member') : null),
    h('table', { class: 'plain' }, h('tbody', {}, state.users.map(userRow))));
}

function approvalCard() {
  const s = state.settings;
  const on = h('input', { type: 'checkbox', checked: s.require_approval === '1' });
  const threshold = h('input', { type: 'number', min: 0, step: '1', value: fromCents(s.approval_threshold_cents) || '0' });
  return h('div', { class: 'card' },
    h('h3', {}, 'Approval'),
    h('label', { class: 'check-label' }, on, 'Student requests need a mentor\'s approval'),
    field('…unless the line total is at or under ($)', threshold),
    h('p', { class: 'note' }, 'Set to 0 to approve every student request. Approved requests are the only ones that go into carts. Mentor requests never need approval.'),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => {
      await attempt(() => api('PUT', '/api/settings', { require_approval: on.checked ? '1' : '0', approval_threshold_cents: toCents(threshold.value) || 0 }), 'Saved');
      refresh();
    } }, 'Save')));
}

function mechanismsCard() {
  const mentor = isMentor();
  const mechList = h('div', {}, state.mechanisms.map((m) => h('div', { class: 'mech-row' },
    h('input', { type: 'color', value: m.color, disabled: !mentor, 'aria-label': 'Color', onchange: (e) => attempt(() => api('PATCH', `/api/mechanisms/${m.id}`, { color: e.target.value })).then(refresh) }),
    h('input', { type: 'text', value: m.name, disabled: !mentor, 'aria-label': 'Name', onchange: (e) => attempt(() => api('PATCH', `/api/mechanisms/${m.id}`, { name: e.target.value })).then(refresh) }),
    h('span', { class: 'note mech-budget' }, m.budget_cents != null ? money(m.budget_cents) : ''),
    mentor ? h('button', { class: 'btn small danger', onclick: async () => {
      if (!confirm(`Remove "${m.name}"? Parts in it become Unassigned.`)) return;
      await attempt(() => api('DELETE', `/api/mechanisms/${m.id}`));
      refresh();
    } }, 'Remove') : null)));

  const newName = h('input', { type: 'text', placeholder: 'New mechanism (e.g. Hood)' });
  const newColor = h('input', { type: 'color', value: '#0ea5e9', 'aria-label': 'Color' });
  const add = async () => {
    if (!newName.value.trim()) return;
    await attempt(() => api('POST', '/api/mechanisms', { name: newName.value.trim(), color: newColor.value }));
    refresh();
  };
  newName.addEventListener('keydown', (e) => e.key === 'Enter' && add());

  return h('div', { class: 'card' }, h('h3', {}, 'Mechanisms'),
    h('p', { class: 'note' }, 'Used to group parts and inventory. Set per-mechanism budgets on the Budget tab.'),
    mechList,
    mentor ? h('div', { class: 'mech-row' }, newColor, newName, h('button', { class: 'btn primary small', onclick: add }, 'Add')) : null);
}

const CART_TEXT = {
  permalink: 'search · one-click cart',
  sequential: 'search · step-by-step cart',
  links: 'search · opens product pages',
  paste: 'paste part links · copy/paste cart',
};

function suppliersCard() {
  return h('div', { class: 'card' }, h('h3', {}, 'Suppliers'),
    h('p', { class: 'note' }, 'You can still add parts from any other supplier by typing them in.'),
    h('ul', { class: 'supplier-list' }, state.suppliers.filter((s) => !s.custom).map((s) => h('li', {},
      h('span', { class: 'dot', style: { background: s.color } }), ' ',
      h('a', { href: `https://${s.domain}`, target: '_blank', rel: 'noopener' }, s.name),
      h('span', { class: 'note' }, ` · ${CART_TEXT[s.cartMode]}${s.searchHint ? ` (${s.searchHint})` : ''}`)))));
}

// Manufacturing board columns (stages) and the list of processes offered on custom parts.
function boardCard() {
  const cols = state.columns;
  // Swap two stages, then save every stage's position so the order is unambiguous.
  const swap = async (i, j) => {
    const order = [...cols];
    [order[i], order[j]] = [order[j], order[i]];
    await attempt(() => Promise.all(order.map((c, k) => api('PATCH', `/api/board-columns/${c.id}`, { sort: k }))));
    refresh();
  };
  const rows = cols.map((c, i) => h('div', { class: 'mech-row' },
    h('input', { type: 'color', value: c.color, 'aria-label': 'Color', onchange: (e) => attempt(() => api('PATCH', `/api/board-columns/${c.id}`, { color: e.target.value })).then(refresh) }),
    h('input', { type: 'text', value: c.name, 'aria-label': 'Stage name', onchange: (e) => attempt(() => api('PATCH', `/api/board-columns/${c.id}`, { name: e.target.value })).then(refresh) }),
    h('button', { class: 'btn small icon', disabled: i === 0, title: 'Move left', 'aria-label': 'Move earlier', onclick: () => swap(i, i - 1) }, '↑'),
    h('button', { class: 'btn small icon', disabled: i === cols.length - 1, title: 'Move right', 'aria-label': 'Move later', onclick: () => swap(i, i + 1) }, '↓'),
    h('button', { class: 'btn small danger', disabled: cols.length === 1, onclick: async () => {
      const count = state.customParts.filter((p) => p.column_id === c.id).length;
      if (!confirm(`Remove the "${c.name}" stage?${count ? ` Its ${count} part(s) move to "${cols.find((x) => x.id !== c.id).name}".` : ''}`)) return;
      await attempt(() => api('DELETE', `/api/board-columns/${c.id}`));
      refresh();
    } }, 'Remove')));

  const newName = h('input', { type: 'text', placeholder: 'New stage (e.g. Powder coat)' });
  const newColor = h('input', { type: 'color', value: '#64748b', 'aria-label': 'Color' });
  const add = async () => {
    if (!newName.value.trim()) return;
    await attempt(() => api('POST', '/api/board-columns', { name: newName.value.trim(), color: newColor.value }));
    refresh();
  };
  newName.addEventListener('keydown', (e) => e.key === 'Enter' && add());

  const processes = h('textarea', { rows: 6 }, state.settings.processes || '');
  return h('div', { class: 'card' }, h('h3', {}, 'Manufacturing board'),
    h('p', { class: 'note' }, 'Stages custom parts move through, left to right. The last stage counts as done.'),
    rows,
    h('div', { class: 'mech-row' }, newColor, newName, h('button', { class: 'btn primary small', onclick: add }, 'Add')),
    field('Processes (one per line)', processes),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => {
      await attempt(() => api('PUT', '/api/settings', { processes: processes.value.split('\n').map((p) => p.trim()).filter(Boolean).join('\n') }), 'Saved');
      refresh();
    } }, 'Save processes')));
}

// Admins connect the team's Onshape account so BOMs load straight from a document link.
function onshapeCard() {
  const access = h('input', { type: 'text', autocomplete: 'off', placeholder: 'Access key' });
  const secret = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Secret key' });
  const status = h('p', { class: state.onshapeConnected ? 'ok-box' : 'note' },
    state.onshapeConnected ? 'Connected. BOM import can load parts from Onshape links.' : 'Not connected.');
  return h('div', { class: 'card' }, h('h3', {}, 'Onshape'),
    status,
    h('p', { class: 'note' },
      'Create API keys at ', h('a', { href: 'https://dev-portal.onshape.com/keys', target: '_blank', rel: 'noopener' }, 'dev-portal.onshape.com/keys'),
      ' (sign in with an account that can see the team\'s documents, and give the key "Read" permission only). Paste both keys here. They stay on this server and are never shown again.'),
    h('div', { class: 'form' }, field('Access key', access), field('Secret key', secret)),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: async () => {
        const res = await attempt(() => api('PUT', '/api/onshape/keys', { access_key: access.value, secret_key: secret.value }));
        if (res) {
          toast(`Connected to Onshape as ${res.name}`);
          refresh();
        }
      } }, state.onshapeConnected ? 'Replace keys' : 'Connect'),
      state.onshapeConnected ? h('button', { class: 'btn danger', onclick: async () => {
        if (!confirm('Disconnect Onshape? BOM import will go back to CSV only.')) return;
        await attempt(() => api('DELETE', '/api/onshape/keys'), 'Disconnected');
        refresh();
      } }, 'Disconnect') : null));
}

// Vendors that aren't built in. Parts from them are tracked normally; they just can't be searched or carted.
function vendorsCard() {
  const mentor = isMentor();
  const rows = state.vendors.map((v) => h('div', { class: 'mech-row' },
    h('input', { type: 'color', value: v.color, disabled: !mentor, 'aria-label': 'Color', onchange: (e) => attempt(() => api('PATCH', `/api/vendors/${v.id}`, { color: e.target.value })).then(refresh) }),
    h('input', { type: 'text', value: v.name, disabled: !mentor, 'aria-label': 'Vendor name', onchange: (e) => attempt(() => api('PATCH', `/api/vendors/${v.id}`, { name: e.target.value }), 'Renamed (existing parts updated too)').then(refresh) }),
    h('input', { type: 'url', value: v.website || '', disabled: !mentor, placeholder: 'Website (optional)', 'aria-label': 'Website', onchange: (e) => attempt(() => api('PATCH', `/api/vendors/${v.id}`, { website: e.target.value.trim() || null })).then(refresh) }),
    mentor ? h('button', { class: 'btn small danger', onclick: async () => {
      if (!confirm(`Remove "${v.name}" from the vendor list? Parts already ordered from it keep the name.`)) return;
      await attempt(() => api('DELETE', `/api/vendors/${v.id}`));
      refresh();
    } }, 'Remove') : null));
  const name = h('input', { type: 'text', placeholder: 'Vendor name (e.g. Misumi, Amazon, local metal shop)' });
  const site = h('input', { type: 'url', placeholder: 'Website (optional)' });
  const add = async () => {
    if (!name.value.trim()) return name.focus();
    const ok = await attempt(() => api('POST', '/api/vendors', { name: name.value.trim(), website: site.value.trim() }), 'Vendor added');
    if (ok) refresh();
  };
  name.addEventListener('keydown', (e) => e.key === 'Enter' && add());
  return h('div', { class: 'card' }, h('h3', {}, 'Other vendors'),
    h('p', { class: 'note' }, 'Suppliers that aren\'t built in. Pick them from the Supplier list when adding a part; anyone can also add one there with "+ Other vendor…".'),
    rows.length ? rows : h('p', { class: 'note' }, 'None yet.'),
    h('div', { class: 'mech-row' }, name, site, h('button', { class: 'btn primary small', onclick: add }, 'Add')));
}

function appearanceCard() {
  return h('div', { class: 'card' }, h('h3', {}, 'Appearance'),
    h('p', { class: 'note' }, 'Saved on this browser only. Auto follows your computer\'s light/dark setting.'),
    seg([['auto', '◐ Auto'], ['light', '☀ Light'], ['dark', '☾ Dark']], prefs.get('theme', 'auto'), (t) => {
      setTheme(t);
      render();
    }));
}

function backupCard() {
  return h('div', { class: 'card' }, h('h3', {}, 'Backup'),
    h('p', { class: 'note' }, 'Downloads everything (orders, inventory, custom parts, accounts, photos and part files) as one .tar file. Keep a copy somewhere safe, like the team Google Drive.'),
    h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '/api/admin/backup' }, 'Download backup')));
}

export function renderSettings() {
  return h('div', { class: 'settings-grid' },
    accountCard(),
    appearanceCard(),
    isMentor() ? teamCard() : null,
    isMentor() ? approvalCard() : null,
    isMentor() ? boardCard() : null,
    can('admin') ? onshapeCard() : null,
    can('admin') ? backupCard() : null,
    mechanismsCard(),
    vendorsCard(),
    suppliersCard());
}
