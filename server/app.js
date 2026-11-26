// The HTTP app. createApp() takes its dependencies (store, auth, suppliers, onshape, backup) so that
// tests can pass fakes. server/index.js wires in the real ones and starts listening.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import {
  HttpError, pick, buildOrderData, buildOrderPatch, computeCardSort, ordersToCsv, parsePartFileName,
  sniffImage, isPrivateAddress, isBuiltInSupplier, STATUSES, INVENTORY_FIELDS, CUSTOM_FIELDS, VENDOR_COLORS,
  FILE_TYPES, MAX_FILE_MB, IMAGE_TYPES, buildTaskData, buildTaskPatch, canDeleteTask,
} from './logic.js';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(SERVER_DIR, '..');

// Dependencies are passed in (never imported here), so this module loads without opening the database.
// store: data.js API. auth: auth.js API. suppliers: suppliers.js. onshape: onshape.js.
export function createApp({
  store,
  auth,
  suppliers,
  onshape,
  createBackup,
  dataDir,
  setupCode = '',
  trustProxy = false,
  projectRoot = DEFAULT_PROJECT_ROOT,
} = {}) {
  if (!dataDir) throw new Error('createApp needs a dataDir');
  if (!createBackup) throw new Error('createApp needs createBackup');
  const app = express();
  if (trustProxy) app.set('trust proxy', true);

  // Basic protections for running on the public internet.
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    next();
  });

  // Health check for the host (no login, no database work).
  app.get('/healthz', (req, res) => res.type('text').send('ok'));
  app.use(express.json({ limit: '2mb' }));
  app.use(auth.loadUser);

  // Async so that synchronous throws in a handler also reach the JSON error response below.
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error(err);
      res.status(err.status && err.status < 500 ? 400 : 500).json({ error: err.message });
    }
  };
  const isSecure = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';
  const mentor = auth.requireRole('mentor');
  const admin = auth.requireRole('admin');
  const isMentor = (user) => auth.isAtLeast(user, 'mentor');
  const settings = () => store.getSettings();
  const isBuiltIn = (name) => isBuiltInSupplier(name, suppliers.SUPPLIERS);

  // -------------------------------------------------------------------------
  // Accounts

  app.get('/api/auth', (req, res) => {
    const setup = auth.userCount() === 0;
    res.json({ setup, setupNeedsCode: setup && !!setupCode, user: auth.publicUser(req.user) });
  });

  // First run only: create the first admin account.
  app.post('/api/setup', wrap((req, res) => {
    if (auth.userCount() > 0) return res.status(400).json({ error: 'Setup is already done.' });
    // On a public server, SETUP_CODE stops a stranger from creating the first admin before you do.
    if (setupCode) {
      const given = Buffer.from(String(req.body?.setup_code || ''));
      const want = Buffer.from(setupCode);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
        return res.status(403).json({ error: 'Wrong setup code.' });
      }
    }
    const { username, display_name, password } = req.body || {};
    if (!username?.trim() || !display_name?.trim()) return res.status(400).json({ error: 'Username and name are required.' });
    const bad = auth.validatePassword(password);
    if (bad) return res.status(400).json({ error: bad });
    const created = store.createUser({ username: username.trim(), display_name: display_name.trim(), password_hash: auth.hashPassword(password), role: 'admin' });
    auth.startSession(res, created.id, isSecure(req));
    res.json({ ok: true });
  }));

  app.post('/api/login', wrap((req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const key = `${req.ip}:${username.toLowerCase()}`;
    if (auth.loginThrottled(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const u = store.findUserByUsername(username);
    if (!u || u.disabled || !auth.verifyPassword(password, u.password_hash)) {
      auth.recordFailedLogin(key);
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    auth.clearFailedLogins(key);
    auth.startSession(res, u.id, isSecure(req));
    res.json({ user: auth.publicUser(u) });
  }));

  app.post('/api/logout', (req, res) => {
    auth.endSession(req, res);
    res.json({ ok: true });
  });

  app.use('/api', auth.requireUser);

  app.patch('/api/me', wrap((req, res) => {
    const { display_name, current_password, new_password } = req.body || {};
    if (display_name?.trim()) store.updateUser(req.user.id, { display_name: display_name.trim() });
    if (new_password) {
      if (!auth.verifyPassword(String(current_password || ''), req.user.password_hash)) {
        return res.status(400).json({ error: 'Current password is wrong.' });
      }
      const bad = auth.validatePassword(new_password);
      if (bad) return res.status(400).json({ error: bad });
      store.updateUser(req.user.id, { password_hash: auth.hashPassword(new_password) });
      auth.endAllSessions(req.user.id);
      auth.startSession(res, req.user.id, isSecure(req));
    }
    res.json({ user: auth.publicUser(store.getUser(req.user.id)) });
  }));

  app.get('/api/users', mentor, (req, res) => {
    res.json(store.listUsers().map(auth.publicUser));
  });

  app.post('/api/users', admin, wrap((req, res) => {
    const { username, display_name, role = 'student', password } = req.body || {};
    if (!username?.trim() || !display_name?.trim()) return res.status(400).json({ error: 'Username and name are required.' });
    if (!auth.ROLES.includes(role)) return res.status(400).json({ error: 'Bad role' });
    const bad = auth.validatePassword(password);
    if (bad) return res.status(400).json({ error: bad });
    if (store.findUserByUsername(username.trim())) {
      return res.status(400).json({ error: 'That username is taken.' });
    }
    const user = store.createUser({ username: username.trim(), display_name: display_name.trim(), password_hash: auth.hashPassword(password), role });
    res.json(auth.publicUser(user));
  }));

  app.patch('/api/users/:id', admin, wrap((req, res) => {
    const id = Number(req.params.id);
    const u = store.getUser(id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    const { display_name, role, disabled, password } = req.body || {};
    const losingAdmin = u.role === 'admin' && ((role && role !== 'admin') || disabled);
    if (losingAdmin && store.countActiveAdmins(id) === 0) return res.status(400).json({ error: 'The team needs at least one admin.' });
    if (role && !auth.ROLES.includes(role)) return res.status(400).json({ error: 'Bad role' });
    if (display_name?.trim()) store.updateUser(id, { display_name: display_name.trim() });
    if (role) store.updateUser(id, { role });
    if (disabled != null) {
      store.updateUser(id, { disabled: disabled ? 1 : 0 });
      if (disabled) auth.endAllSessions(id);
    }
    if (password) {
      const bad = auth.validatePassword(password);
      if (bad) return res.status(400).json({ error: bad });
      store.updateUser(id, { password_hash: auth.hashPassword(password) });
      auth.endAllSessions(id);
    }
    res.json(auth.publicUser(store.getUser(id)));
  }));

  app.delete('/api/users/:id', admin, wrap((req, res) => {
    const id = Number(req.params.id);
    const u = store.getUser(id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    if (id === req.user.id) return res.status(400).json({ error: "You can't delete your own account." });
    if (u.role === 'admin' && store.countActiveAdmins(id) === 0) return res.status(400).json({ error: 'The team needs at least one admin.' });
    store.deleteUser(id);
    res.json({ ok: true });
  }));

  // -------------------------------------------------------------------------
  // Meta, settings, mechanisms

  app.get('/api/meta', (req, res) => {
    res.json({
      user: auth.publicUser(req.user),
      suppliers: suppliers.publicSuppliers(),
      mechanisms: store.listMechanisms(),
      settings: store.getSettings(),
      columns: store.listBoardColumns(),
      team: store.listTeam(),
      onshapeConnected: onshape.isConfigured(),
      vendors: store.listVendors(),
    });
  });

  app.put('/api/settings', mentor, wrap((req, res) => {
    res.json(store.saveSettings(req.body || {}));
  }));

  app.post('/api/mechanisms', mentor, wrap((req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name required' });
    const sort = store.nextMechanismSort();
    res.json(store.createMechanism({ name, color: req.body.color || '#64748b', sort }));
  }));

  app.patch('/api/mechanisms/:id', mentor, wrap((req, res) => {
    res.json(store.updateMechanism(Number(req.params.id), pick(req.body, ['name', 'color', 'sort', 'budget_cents'])));
  }));

  app.delete('/api/mechanisms/:id', mentor, wrap((req, res) => {
    store.deleteMechanism(Number(req.params.id));
    res.json({ ok: true });
  }));

  // -------------------------------------------------------------------------
  // Orders

  app.get('/api/orders', (req, res) => {
    res.json(store.listOrders());
  });

  // Create one order. Writes the row, plus a status timestamp when the status isn't 'needed'.
  const createOrder = (user, body) => {
    const data = buildOrderData(user, body, settings());
    const row = store.insertOrder(data);
    return data.status && data.status !== 'needed' ? store.updateOrder(row.id, {}, store.statusTimestamps(data.status)) : row;
  };

  app.post('/api/orders', wrap((req, res) => {
    res.json(createOrder(req.user, req.body || {}));
  }));

  // Create many at once (BOM import, restock).
  app.post('/api/orders/bulk', wrap((req, res) => {
    const list = Array.isArray(req.body?.orders) ? req.body.orders.slice(0, 500) : [];
    res.json(store.transaction(() => list.map((o) => createOrder(req.user, o))));
  }));

  app.patch('/api/orders/:id', wrap((req, res) => {
    const order = store.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Not found' });
    const mentorEdit = isMentor(req.user);
    if (!mentorEdit) {
      if (order.created_by !== req.user.id) return res.status(403).json({ error: 'You can only edit your own requests.' });
      if (order.status !== 'needed') return res.status(403).json({ error: 'This part has already been ordered.' });
    }
    const data = buildOrderPatch(req.user, order, req.body, mentorEdit, settings());
    res.json(store.updateOrder(order.id, data, data.status ? store.statusTimestamps(data.status) : ''));
  }));

  app.post('/api/orders/:id/approve', mentor, wrap((req, res) => {
    const order = store.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Not found' });
    res.json(store.updateOrder(order.id, { approval: 'approved', approved_by: req.user.display_name, rejection_reason: null }, store.APPROVED_NOW));
  }));

  app.post('/api/orders/:id/reject', mentor, wrap((req, res) => {
    const order = store.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Not found' });
    res.json(store.updateOrder(order.id, {
      approval: 'rejected', approved_by: req.user.display_name, rejection_reason: String(req.body?.reason || '').trim() || null,
    }, store.APPROVED_NOW));
  }));

  app.post('/api/orders/bulk-approve', mentor, wrap((req, res) => {
    const ids = (req.body?.ids || []).map(Number);
    for (const id of ids) store.updateOrder(id, { approval: 'approved', approved_by: req.user.display_name, rejection_reason: null }, store.APPROVED_NOW);
    res.json({ ok: true });
  }));

  // Change status for many orders; optionally record the supplier order number and tracking.
  app.post('/api/orders/bulk-status', mentor, wrap((req, res) => {
    const { ids = [], status, order_number, tracking_number, carrier } = req.body || {};
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Bad status' });
    const extra = {};
    if (order_number) extra.order_number = String(order_number).trim();
    if (tracking_number) extra.tracking_number = String(tracking_number).trim();
    if (carrier) extra.carrier = String(carrier).trim();
    let skipped = 0;
    for (const id of ids) {
      const o = store.getOrder(id);
      if (!o) continue;
      if (status !== 'needed' && o.approval !== 'approved') {
        skipped++;
        continue;
      }
      store.updateOrder(o.id, { status, ...extra }, store.statusTimestamps(status));
    }
    res.json({ ok: true, skipped });
  }));

  app.post('/api/orders/bulk-tracking', mentor, wrap((req, res) => {
    const { ids = [], order_number, tracking_number, carrier } = req.body || {};
    const data = pick({ order_number, tracking_number, carrier }, ['order_number', 'tracking_number', 'carrier']);
    for (const id of ids) store.updateOrder(Number(id), data);
    res.json({ ok: true });
  }));

  app.delete('/api/orders/:id', wrap((req, res) => {
    const order = store.getOrder(req.params.id);
    if (!order) return res.json({ ok: true });
    if (!isMentor(req.user) && (order.created_by !== req.user.id || order.status !== 'needed')) {
      return res.status(403).json({ error: 'You can only delete your own requests that have not been ordered.' });
    }
    store.deleteOrder(order.id);
    res.json({ ok: true });
  }));

  // Mark an order arrived and put its quantity on the inventory shelf.
  app.post('/api/orders/:id/receive', wrap((req, res) => {
    const order = store.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Not found' });
    const qty = Math.max(0, Number(req.body?.quantity ?? order.quantity) || 0);
    const location = req.body?.location || null;

    res.json(store.transaction(() => {
      let item = store.findInventoryMatch(order);
      if (item) {
        item = store.addToInventory(item.id, qty, location ? { location } : {});
      } else {
        const data = pick(order, INVENTORY_FIELDS.filter((f) => f !== 'min_quantity'));
        item = store.insertInventory({ ...data, quantity: qty, location });
      }
      const updated = store.updateOrder(order.id, { status: 'arrived' }, store.statusTimestamps('arrived'));
      return { order: updated, inventory: item };
    }));
  }));

  app.get('/api/orders.csv', (req, res) => {
    const mechs = Object.fromEntries(store.listMechanisms().map((m) => [m.id, m.name]));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    res.send(ordersToCsv(store.listOrdersBySupplier(), mechs));
  });

  // -------------------------------------------------------------------------
  // Inventory

  app.get('/api/inventory', (req, res) => {
    res.json(store.listInventory());
  });

  app.post('/api/inventory', wrap((req, res) => {
    const data = pick(req.body, INVENTORY_FIELDS);
    if (!data.name) return res.status(400).json({ error: 'Name required' });
    // Adding something we already track just bumps the count.
    const existing = store.findInventoryMatch(data);
    if (existing && req.body.merge !== false) {
      return res.json(store.addToInventory(existing.id, Number(data.quantity) || 0));
    }
    res.json(store.insertInventory(data));
  }));

  app.patch('/api/inventory/:id', wrap((req, res) => {
    const data = pick(req.body, INVENTORY_FIELDS);
    if ('quantity' in data) data.quantity = Math.max(0, Number(data.quantity) || 0);
    if ('min_quantity' in data) data.min_quantity = Math.max(0, Number(data.min_quantity) || 0);
    res.json(store.updateInventory(Number(req.params.id), data, store.UPDATED_NOW));
  }));

  app.delete('/api/inventory/:id', mentor, wrap((req, res) => {
    store.deleteInventory(Number(req.params.id));
    res.json({ ok: true });
  }));

  // Turn low-stock inventory rows into part requests: [{ id, quantity }].
  app.post('/api/inventory/reorder', wrap((req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    res.json(store.transaction(() => {
      const created = [];
      for (const { id, quantity } of items) {
        const inv = store.getInventory(id);
        if (!inv || !(Number(quantity) > 0)) continue;
        const data = pick(inv, ['name', 'description', 'supplier', 'sku', 'url', 'image', 'product_id', 'variant_id', 'variant_title', 'unit_price_cents', 'mechanism_id']);
        created.push(createOrder(req.user, { ...data, quantity: Number(quantity), notes: `Restock (min ${inv.min_quantity}, had ${inv.quantity})` }));
      }
      return created;
    }));
  }));

  // -------------------------------------------------------------------------
  // Custom parts (made in-house) and the manufacturing board

  // Create one custom part. Throws a 400 HttpError when the name is missing.
  const createCustom = (user, body) => {
    const data = pick(body, CUSTOM_FIELDS);
    if (!data.name?.trim()) throw new HttpError(400, 'Part name required');
    data.name = data.name.trim();
    if (!data.column_id) data.column_id = store.listBoardColumns()[0]?.id ?? null;
    data.sort = store.nextCardSort(data.column_id);
    data.created_by = user.id;
    const row = store.insertCustomPart(data);
    return store.updateCustomPart(row.id, {}, store.columnTimestamps(row.column_id));
  };

  const withFiles = (part) => part && { ...part, files: store.listPartFilesFor(part.id), tasks: store.listTasksFor(part.id) };

  // Throws a 400 when a task is assigned to someone who isn't on the team.
  const checkAssignee = (id) => {
    if (id != null && !store.getUser(id)) throw new HttpError(400, 'Unknown team member');
  };

  // Throws a 400 when a task is put in a stage that isn't on the board.
  const checkStage = (id) => {
    if (id != null && !store.listBoardColumns().some((c) => c.id === id)) throw new HttpError(400, 'Unknown stage');
  };

  // Add one checklist task to the end of a part's list. With no stage given it goes in the part's current stage.
  const addTask = (user, part, body) => {
    const data = buildTaskData(body);
    checkAssignee(data.assigned_to);
    checkStage(data.column_id);
    return store.insertTask({ ...data, column_id: data.column_id ?? part.column_id ?? null,
      custom_part_id: part.id, sort: store.nextTaskSort(part.id), created_by: user.id });
  };

  // Files are uploaded before the part is saved, then attached by id. Only your own unattached uploads can be attached.
  const attachFiles = (user, partId, fileIds) => {
    if (!Array.isArray(fileIds)) return;
    for (const id of fileIds) store.attachPartFile(partId, id, user.id);
  };

  app.get('/api/custom-parts', (req, res) => {
    const group = (rows) => {
      const byPart = new Map();
      for (const r of rows) byPart.set(r.custom_part_id, [...(byPart.get(r.custom_part_id) || []), r]);
      return byPart;
    };
    const files = group(store.listAttachedPartFiles());
    const tasks = group(store.listAllTasks());
    res.json(store.listCustomParts().map((p) => ({ ...p, files: files.get(p.id) || [], tasks: tasks.get(p.id) || [] })));
  });

  // A new part can bring its first checklist tasks along (body.tasks), created in the same transaction.
  app.post('/api/custom-parts', wrap((req, res) => {
    const body = req.body || {};
    const part = store.transaction(() => {
      const created = createCustom(req.user, body);
      for (const t of Array.isArray(body.tasks) ? body.tasks.slice(0, 50) : []) {
        const task = addTask(req.user, created, t);
        // A task ticked before the part was first saved arrives already done.
        if (t.done) store.updateTask(task.id, { done: 1, done_by: req.user.id }, store.taskDoneTimestamps(true));
      }
      return created;
    });
    attachFiles(req.user, part.id, body.file_ids);
    res.json(withFiles(part));
  }));

  app.post('/api/custom-parts/bulk', wrap((req, res) => {
    const list = Array.isArray(req.body?.parts) ? req.body.parts.slice(0, 500) : [];
    res.json(store.transaction(() => list.map((p) => createCustom(req.user, p))));
  }));

  app.patch('/api/custom-parts/:id', wrap((req, res) => {
    const part = store.getCustomPart(req.params.id);
    if (!part) return res.status(404).json({ error: 'Not found' });
    const data = pick(req.body, CUSTOM_FIELDS);
    if ('quantity_done' in data) data.quantity_done = Math.max(0, Number(data.quantity_done) || 0);
    const moved = 'column_id' in data && Number(data.column_id) !== part.column_id;
    if (moved) data.sort = store.nextCardSort(data.column_id);
    const extra = [store.UPDATED_NOW];
    if (moved) extra.push(store.columnTimestamps(data.column_id));
    const updated = store.updateCustomPart(part.id, data, extra.join(', '));
    attachFiles(req.user, part.id, req.body?.file_ids);
    res.json(withFiles(updated));
  }));

  // Drag and drop: put a part in a column, before another card (or at the end).
  app.post('/api/custom-parts/:id/move', wrap((req, res) => {
    const part = store.getCustomPart(req.params.id);
    if (!part) return res.status(404).json({ error: 'Not found' });
    const columnId = Number(req.body?.column_id);
    if (!store.listBoardColumns().some((c) => c.id === columnId)) return res.status(400).json({ error: 'Unknown column' });
    const sort = computeCardSort(store.cardsInColumn(columnId, part.id), req.body?.before_id);
    const extra = [store.UPDATED_NOW];
    if (columnId !== part.column_id) extra.push(store.columnTimestamps(columnId));
    res.json(store.updateCustomPart(part.id, { column_id: columnId, sort }, extra.join(', ')));
  }));

  app.delete('/api/custom-parts/:id', wrap((req, res) => {
    const part = store.getCustomPart(req.params.id);
    if (!part) return res.json({ ok: true });
    if (!isMentor(req.user) && part.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Only mentors or the person who added it can delete this part.' });
    }
    store.deleteCustomPart(part.id).forEach((storedName) => removeStoredFile(storedName));
    res.json({ ok: true });
  }));

  // -------------------------------------------------------------------------
  // Checklist tasks on custom parts. Anyone signed in can add and check off tasks, like editing the part.

  app.post('/api/custom-parts/:id/tasks', wrap((req, res) => {
    const part = store.getCustomPart(req.params.id);
    if (!part) return res.status(404).json({ error: 'Not found' });
    res.json(addTask(req.user, part, req.body || {}));
  }));

  app.patch('/api/tasks/:id', wrap((req, res) => {
    const task = store.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });
    const patch = buildTaskPatch(req.body || {});
    if ('assigned_to' in patch) checkAssignee(patch.assigned_to);
    if ('column_id' in patch) checkStage(patch.column_id);
    if (patch.done && !task.done) patch.done_by = req.user.id;
    res.json(store.updateTask(task.id, patch, 'done' in patch ? store.taskDoneTimestamps(patch.done) : ''));
  }));

  app.delete('/api/tasks/:id', wrap((req, res) => {
    const task = store.getTask(req.params.id);
    if (!task) return res.json({ ok: true });
    if (!canDeleteTask(req.user, task, store.getCustomPart(task.custom_part_id))) {
      return res.status(403).json({ error: 'Only mentors, the person who added the task, or the person who added the part can delete it.' });
    }
    store.deleteTask(task.id);
    res.json({ ok: true });
  }));

  app.post('/api/board-columns', mentor, wrap((req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name required' });
    const sort = store.nextBoardColumnSort();
    res.json(store.createBoardColumn({ name, color: req.body.color || '#64748b', sort }));
  }));

  app.patch('/api/board-columns/:id', mentor, wrap((req, res) => {
    res.json(store.updateBoardColumn(Number(req.params.id), pick(req.body, ['name', 'color', 'sort'])));
  }));

  // Remove a column; its cards move to the first remaining column.
  app.delete('/api/board-columns/:id', mentor, wrap((req, res) => {
    const id = Number(req.params.id);
    const rest = store.listBoardColumns().filter((c) => c.id !== id);
    if (!rest.length) return res.status(400).json({ error: 'The board needs at least one column.' });
    store.deleteBoardColumn(id, rest[0].id);
    res.json({ ok: true });
  }));

  // -------------------------------------------------------------------------
  // Vendors (suppliers that aren't built in)

  // Anyone can add a vendor (e.g. while adding a part). Adding an existing name returns it.
  app.post('/api/vendors', wrap((req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Vendor name required' });
    if (isBuiltIn(name)) return res.status(400).json({ error: `${name} is already a built-in supplier.` });
    const existing = store.findVendorByName(name);
    if (existing) return res.json(existing);
    const count = store.countVendors();
    res.json(store.createVendor({ name, website: String(req.body.website || '').trim() || null, color: req.body.color || VENDOR_COLORS[count % VENDOR_COLORS.length] }));
  }));

  // Renaming a vendor also renames it on existing orders and inventory.
  app.patch('/api/vendors/:id', mentor, wrap((req, res) => {
    const v = store.getVendor(Number(req.params.id));
    if (!v) return res.status(404).json({ error: 'Not found' });
    const data = pick(req.body, ['name', 'website', 'color']);
    if (data.name != null) {
      data.name = String(data.name).trim();
      if (!data.name) return res.status(400).json({ error: 'Vendor name required' });
      if (isBuiltIn(data.name)) return res.status(400).json({ error: `${data.name} is already a built-in supplier.` });
    }
    res.json(store.renameVendor(v, data));
  }));

  // Removing a vendor keeps its name on existing orders; it just leaves the list.
  app.delete('/api/vendors/:id', mentor, wrap((req, res) => {
    store.deleteVendor(Number(req.params.id));
    res.json({ ok: true });
  }));

  // -------------------------------------------------------------------------
  // Onshape

  // Admins save the team's API keys. They are never sent back to the browser.
  app.put('/api/onshape/keys', admin, wrap(async (req, res) => {
    const { access_key, secret_key } = req.body || {};
    if (!access_key?.trim() || !secret_key?.trim()) return res.status(400).json({ error: 'Both keys are required.' });
    onshape.saveKeys(access_key, secret_key);
    try {
      res.json({ ok: true, ...(await onshape.testConnection()) });
    } catch (err) {
      onshape.saveKeys('', ''); // don't keep keys that don't work
      res.status(400).json({ error: err.message });
    }
  }));

  app.delete('/api/onshape/keys', admin, (req, res) => {
    onshape.saveKeys('', '');
    res.json({ ok: true });
  });

  // Parts from an Onshape assembly (BOM) or Part Studio link, shaped like CSV BOM rows.
  app.post('/api/onshape/bom', wrap(async (req, res) => {
    res.json(await onshape.fetchParts(req.body?.url));
  }));

  // -------------------------------------------------------------------------
  // Supplier catalog

  app.get('/api/search', wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ results: [], errors: [] });
    const keys = req.query.suppliers ? String(req.query.suppliers).split(',') : undefined;
    res.json(await suppliers.search(q, keys, Math.min(Number(req.query.limit) || 8, 20)));
  }));

  app.get('/api/product', wrap(async (req, res) => {
    res.json(await suppliers.product(String(req.query.supplier), String(req.query.handle)));
  }));

  // Other sizes of the same part sold as separate products (e.g. WCP gears).
  app.get('/api/siblings', wrap(async (req, res) => {
    res.json(await suppliers.siblings(String(req.query.supplier), String(req.query.handle || ''), String(req.query.title || ''), req.query.product_id ? String(req.query.product_id) : null));
  }));

  app.get('/api/lookup', wrap(async (req, res) => {
    const p = await suppliers.lookupUrl(String(req.query.url || ''));
    if (!p) return res.status(400).json({ error: 'That supplier is not supported for auto-fill yet. Enter the details by hand.' });
    res.json(p);
  }));

  // Match BOM part numbers to supplier products: rows = [{ partNumber, description }].
  app.post('/api/match', wrap(async (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 60) : [];
    const out = new Array(rows.length).fill(null);
    let next = 0;
    // A few at a time so supplier sites don't rate-limit us.
    const worker = async () => {
      while (next < rows.length) {
        const i = next++;
        try {
          out[i] = await suppliers.matchSku(rows[i].partNumber, { description: rows[i].description });
        } catch {
          out[i] = null;
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    res.json(out.map((m, i) => ({
      index: i,
      supplier: m?.product.supplier || suppliers.supplierForSku(rows[i].partNumber)?.key || null,
      match: m,
    })));
  }));

  // Build a supplier cart from approved "needed" orders (defaults to all of them for that supplier).
  app.post('/api/cart', mentor, wrap((req, res) => {
    const { supplier, orderIds } = req.body || {};
    const rows = (orderIds?.length
      ? store.ordersByIds(orderIds.map(Number))
      : store.ordersNeededFor(supplier))
      .filter((r) => r.supplier === supplier && r.approval === 'approved');
    const items = rows.map((r) => ({
      orderIds: [r.id], name: r.name, quantity: r.quantity, variantId: r.variant_id, productId: r.product_id, sku: r.sku, url: r.url,
    }));
    const cart = suppliers.buildCart(supplier, items);
    res.json({ ...cart, orderIds: items.map((i) => i.orderIds[0]) });
  }));

  // -------------------------------------------------------------------------
  // Photos (parts not from a vendor, custom parts). The browser shrinks them before uploading.

  const uploadsDir = path.resolve(dataDir, 'uploads'); // absolute: res.sendFile rejects relative paths
  mkdirSync(uploadsDir, { recursive: true });

  function saveImage(buf) {
    const type = sniffImage(buf);
    if (!type) return null;
    const name = `${crypto.randomBytes(16).toString('hex')}.${type.ext}`;
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(path.join(uploadsDir, name), buf);
    return `/api/uploads/${name}`;
  }

  app.post('/api/uploads', express.raw({ type: 'image/*', limit: '8mb' }), wrap((req, res) => {
    const url = IMAGE_TYPES[String(req.headers['content-type'] || '').split(';')[0].trim()] ? saveImage(req.body) : null;
    if (!url) return res.status(400).json({ error: 'Upload a JPEG, PNG, WebP or GIF image.' });
    res.json({ url });
  }));

  // Copying an image on a website often gives a link instead of the picture. Fetch it here.
  // Only public http(s) addresses are allowed, so this can't be used to reach machines on the school network.
  // `lookup` and `fetchImpl` are injectable for tests.
  async function fetchPublicImage(rawUrl, { lookup = (h) => dns.lookup(h, { all: true }), fetchImpl = fetch } = {}) {
    let url = rawUrl;
    for (let hop = 0; hop < 4; hop++) {
      let u;
      try {
        u = new URL(url);
      } catch {
        throw new HttpError(400, "That isn't a link to an image.");
      }
      if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'Only web (http/https) image links work.');
      const addrs = await lookup(u.hostname).catch(() => []);
      if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
        throw new HttpError(400, "That image's website couldn't be reached.");
      }
      const res = await fetchImpl(u, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FRC1073-PartsTracker)', Accept: 'image/*' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location'), u).href;
        continue;
      }
      if (!res.ok) throw new HttpError(400, `The image's website responded ${res.status}.`);
      if (Number(res.headers.get('content-length')) > 8 * 1024 * 1024) throw new HttpError(400, 'That image is too large (over 8 MB).');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 8 * 1024 * 1024) throw new HttpError(400, 'That image is too large (over 8 MB).');
      return buf;
    }
    throw new HttpError(400, 'That image link redirects too many times.');
  }

  app.post('/api/uploads/from-url', wrap(async (req, res) => {
    const buf = await fetchPublicImage(String(req.body?.url || '').trim());
    const url = saveImage(buf);
    if (!url) return res.status(400).json({ error: "That link isn't a JPEG, PNG, WebP or GIF image. Try right-click → Copy image instead." });
    res.json({ url });
  }));

  // -------------------------------------------------------------------------
  // Part files (STEP, STL, 3MF, DXF, G-code, PDF drawings) attached to custom parts.

  const filesDir = path.resolve(dataDir, 'files');
  mkdirSync(filesDir, { recursive: true });

  function removeStoredFile(storedName) {
    try {
      unlinkSync(path.join(filesDir, storedName));
    } catch {
      // already gone
    }
  }

  // Body is the raw file; ?name= carries the original file name.
  app.post('/api/files', express.raw({ type: () => true, limit: `${MAX_FILE_MB}mb` }), wrap((req, res) => {
    const parsed = parsePartFileName(req.query.name);
    if (!parsed) {
      return res.status(400).json({ error: `Attach a ${FILE_TYPES.map((t) => '.' + t).join(', ')} file.` });
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'That file is empty.' });
    const storedName = `${crypto.randomBytes(16).toString('hex')}.${parsed.ext}`;
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(path.join(filesDir, storedName), req.body);
    const row = store.insertPartFile({ name: parsed.name, stored_name: storedName, size: req.body.length, uploaded_by: req.user.id });
    res.json({ id: row.id, name: row.name, size: row.size, custom_part_id: null });
  }));

  // Downloads always save as a file (never open in the browser).
  app.get('/api/files/:id', (req, res) => {
    const f = store.getPartFile(req.params.id);
    if (!f) return res.status(404).json({ error: 'File not found' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.download(path.join(filesDir, f.stored_name), f.name, { headers: { 'Content-Type': 'application/octet-stream' } },
      (err) => err && !res.headersSent && res.status(404).json({ error: 'File missing on the server' }));
  });

  app.delete('/api/files/:id', wrap((req, res) => {
    const f = store.getPartFile(req.params.id);
    if (!f) return res.json({ ok: true });
    if (!isMentor(req.user) && f.uploaded_by !== req.user.id) {
      return res.status(403).json({ error: 'Only mentors or the person who attached it can remove this file.' });
    }
    store.deletePartFile(f.id);
    removeStoredFile(f.stored_name);
    res.json({ ok: true });
  }));

  // Only signed-in team members can see photos.
  app.get('/api/uploads/:name', (req, res) => {
    if (!/^[0-9a-f]{32}\.(jpg|png|webp|gif)$/.test(req.params.name)) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(path.join(uploadsDir, req.params.name), (err) => err && !res.headersSent && res.status(404).end());
  });

  // Admins download everything (database + photos + part files) as one .tar file.
  app.get('/api/admin/backup', admin, (req, res) => {
    const stamp = new Date().toISOString().slice(0, 10);
    try {
      const chunks = [...createBackup(path.resolve(dataDir))];
      res.setHeader('Content-Type', 'application/x-tar');
      res.setHeader('Content-Disposition', `attachment; filename="parts-backup-${stamp}.tar"`);
      for (const chunk of chunks) res.write(chunk);
      res.end();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Backup failed' });
    }
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // 3D viewer libraries, served from node_modules so the viewer works without internet access.
  const modules = path.join(projectRoot, 'node_modules');
  app.use('/vendor/three', express.static(path.join(modules, 'three'), { maxAge: '30d' }));
  app.use('/vendor/occt', express.static(path.join(modules, 'occt-import-js', 'dist'), { maxAge: '30d' }));
  app.use(express.static(path.join(projectRoot, 'public')));
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(projectRoot, 'public', 'index.html')));

  return { app, uploadsDir, filesDir, fetchPublicImage, removeStoredFile };
}
