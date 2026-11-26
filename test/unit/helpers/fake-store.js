// In-memory stand-in for server/data.js, covering the calls the route tests make.
// Every write is recorded in `calls` so tests can assert on what the route asked the store to do.
export function makeFakeStore({ settings = {}, users = [], orders = [], mechanisms = [], inventory = [], columns = [], customParts = [], tasks = [] } = {}) {
  const s = {
    settings: { require_approval: '0', approval_threshold_cents: '0', processes: '', ...settings },
    users: users.map((u) => ({ disabled: 0, ...u })),
    orders: orders.map((o) => ({ ...o })),
    mechanisms: mechanisms.map((m) => ({ ...m })),
    inventory: inventory.map((i) => ({ ...i })),
    columns: columns.map((c) => ({ ...c })),
    customParts: customParts.map((p) => ({ ...p })),
    partFiles: [],
    tasks: tasks.map((t) => ({ done: 0, ...t })),
    calls: [],
    lastId: 500,
  };
  const nextId = () => ++s.lastId;
  const byId = (list, id) => list.find((x) => x.id === Number(id)) ?? null;
  const record = (op, ...args) => s.calls.push({ op, args });

  const store = {
    APPROVED_NOW: 'approved_at = NOW',
    UPDATED_NOW: 'updated_at = NOW',
    statusTimestamps: (status) => (status ? `${status}_at = NOW` : ''),
    columnTimestamps: (columnId) => `column_at(${columnId}) = NOW`,
    transaction: (fn) => fn(),

    getSettings: () => ({ ...s.settings }),
    saveSettings: (body) => {
      Object.assign(s.settings, body);
      return { ...s.settings };
    },

    countUsers: () => s.users.length,
    getUser: (id) => byId(s.users, id),
    findUserByUsername: (name) => s.users.find((u) => u.username === name) ?? null,
    listUsers: () => s.users.slice(),
    listTeam: () => s.users.map((u) => ({ id: u.id, display_name: u.display_name })),
    createUser: (data) => {
      const u = { id: nextId(), disabled: 0, created_at: '2026-01-01', ...data };
      s.users.push(u);
      record('createUser', data);
      return u;
    },
    updateUser: (id, data) => {
      const u = byId(s.users, id);
      if (u) Object.assign(u, data);
      record('updateUser', id, data);
      return u;
    },
    countActiveAdmins: (exceptId) => s.users.filter((u) => u.role === 'admin' && !u.disabled && u.id !== exceptId).length,
    deleteUser: (id) => {
      s.users = s.users.filter((u) => u.id !== Number(id));
      record('deleteUser', id);
    },

    listMechanisms: () => s.mechanisms.slice(),

    getOrder: (id) => byId(s.orders, id),
    listOrdersBySupplier: () => s.orders.slice().sort((a, b) => String(a.supplier).localeCompare(String(b.supplier))),
    ordersByIds: (ids) => s.orders.filter((o) => ids.includes(o.id)),
    ordersNeededFor: (supplier) => s.orders.filter((o) => o.supplier === supplier && o.status === 'needed'),
    insertOrder: (data) => {
      const row = { id: nextId(), status: 'needed', ...data };
      s.orders.push(row);
      record('insertOrder', data);
      return row;
    },
    updateOrder: (id, data, extra = '') => {
      const o = byId(s.orders, id);
      if (!o) return null;
      Object.assign(o, data);
      record('updateOrder', id, data, extra);
      return o;
    },

    deleteOrder: (id) => {
      s.orders = s.orders.filter((o) => o.id !== Number(id));
      record('deleteOrder', id);
    },

    findInventoryMatch: (order) => s.inventory.find((i) => i.name === order.name) ?? null,
    getInventory: (id) => byId(s.inventory, id),
    addToInventory: (id, qty, extra = {}) => {
      const item = byId(s.inventory, id);
      item.quantity += qty;
      Object.assign(item, extra);
      record('addToInventory', id, qty, extra);
      return item;
    },
    updateInventory: (id, data) => {
      const item = byId(s.inventory, id);
      Object.assign(item, data);
      record('updateInventory', id, data);
      return item;
    },
    insertInventory: (data) => {
      const row = { id: nextId(), quantity: 0, ...data };
      s.inventory.push(row);
      record('insertInventory', data);
      return row;
    },

    listBoardColumns: () => s.columns.slice(),
    nextCardSort: (columnId) => {
      const sorts = s.customParts.filter((p) => p.column_id === Number(columnId)).map((p) => p.sort);
      return sorts.length ? Math.max(...sorts) + 1 : 1;
    },
    cardsInColumn: (columnId, excludeId) => s.customParts
      .filter((p) => p.column_id === Number(columnId) && p.id !== Number(excludeId))
      .sort((a, b) => a.sort - b.sort),
    getCustomPart: (id) => byId(s.customParts, id),
    insertCustomPart: (data) => {
      const row = { id: nextId(), ...data };
      s.customParts.push(row);
      record('insertCustomPart', data);
      return row;
    },
    updateCustomPart: (id, data, extra = '') => {
      const p = byId(s.customParts, id);
      Object.assign(p, data);
      record('updateCustomPart', id, data, extra);
      return p;
    },
    listCustomParts: () => s.customParts.slice(),
    listAttachedPartFiles: () => [],
    listPartFilesFor: () => [],
    attachPartFile: (partId, fileId, userId) => record('attachPartFile', partId, fileId, userId),
    insertPartFile: (data) => {
      const row = { id: nextId(), ...data };
      s.partFiles.push(row);
      return row;
    },
    getPartFile: (id) => byId(s.partFiles, id),
    deletePartFile: (id) => {
      s.partFiles = s.partFiles.filter((f) => f.id !== Number(id));
    },

    listTasksFor: (partId) => s.tasks.filter((t) => t.custom_part_id === Number(partId)).sort((a, b) => a.sort - b.sort),
    listAllTasks: () => s.tasks.slice().sort((a, b) => a.custom_part_id - b.custom_part_id || a.sort - b.sort),
    getTask: (id) => byId(s.tasks, id),
    nextTaskSort: (partId) => {
      const sorts = s.tasks.filter((t) => t.custom_part_id === Number(partId)).map((t) => t.sort);
      return sorts.length ? Math.max(...sorts) + 1 : 1;
    },
    insertTask: (data) => {
      const row = { id: nextId(), done: 0, ...data };
      s.tasks.push(row);
      record('insertTask', data);
      return row;
    },
    updateTask: (id, data, extra = '') => {
      const t = byId(s.tasks, id);
      Object.assign(t, data);
      record('updateTask', id, data, extra);
      return t;
    },
    taskDoneTimestamps: (done) => (done ? 'done_at = NOW' : 'done_at = NULL, done_by = NULL'),
    deleteTask: (id) => {
      s.tasks = s.tasks.filter((t) => t.id !== Number(id));
      record('deleteTask', id);
    },

    listVendors: () => [],
    findVendorByName: () => null,
    countVendors: () => 0,
    createVendor: (data) => ({ id: nextId(), ...data }),
  };

  return { store, state: s };
}
