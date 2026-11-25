// Pure business rules used by the HTTP routes. No database, no network, no globals.
// Errors that map to a client response carry a `status` property (see wrap() in app.js).
import net from 'node:net';
import path from 'node:path';
import { isAtLeast } from './auth-core.js';

export const ORDER_FIELDS = [
  'name', 'description', 'supplier', 'sku', 'url', 'image', 'product_id', 'variant_id', 'variant_title',
  'unit_price_cents', 'quantity', 'mechanism_id', 'status', 'priority', 'requested_by', 'notes',
  'order_number', 'tracking_number', 'carrier',
];
// Fields a student may set on their own request.
export const STUDENT_ORDER_FIELDS = [
  'name', 'description', 'supplier', 'sku', 'url', 'image', 'product_id', 'variant_id', 'variant_title',
  'unit_price_cents', 'quantity', 'mechanism_id', 'priority', 'notes',
];
// Changing any of these on an approved request sends it back for approval.
export const APPROVAL_SENSITIVE = ['quantity', 'unit_price_cents', 'variant_id', 'product_id', 'supplier', 'sku'];
export const INVENTORY_FIELDS = [
  'name', 'description', 'supplier', 'sku', 'url', 'image', 'product_id', 'variant_id', 'variant_title',
  'unit_price_cents', 'quantity', 'location', 'mechanism_id', 'notes', 'min_quantity',
];
export const CUSTOM_FIELDS = [
  'name', 'part_number', 'cad_url', 'mechanism_id', 'quantity', 'quantity_done', 'material', 'process',
  'column_id', 'priority', 'assigned_to', 'designer', 'due_date', 'notes', 'image',
];
export const STATUSES = ['needed', 'ordered', 'arrived'];
export const VENDOR_COLORS = ['#0ea5e9', '#a855f7', '#f43f5e', '#22c55e', '#eab308', '#14b8a6', '#f97316', '#6366f1'];
export const FILE_TYPES = ['step', 'stp', 'stl', '3mf', 'obj', 'dxf', 'dwg', 'gcode', 'bgcode', 'f3d', 'sldprt', 'pdf'];
export const MAX_FILE_MB = 100;
export const IMAGE_TYPES = {
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  'image/png': { ext: 'png', magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  'image/webp': { ext: 'webp', magic: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  'image/gif': { ext: 'gif', magic: (b) => b.toString('ascii', 0, 3) === 'GIF' },
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Copy the known fields from a request body. '' becomes null; absent keys are left out.
export function pick(body, fields) {
  const out = {};
  for (const f of fields) if (f in body) out[f] = body[f] === '' ? null : body[f];
  return out;
}

// Does a new request from this user need a mentor's OK?
export function needsApproval(user, data, settings) {
  if (isAtLeast(user, 'mentor')) return false;
  if (settings.require_approval !== '1') return false;
  const threshold = Number(settings.approval_threshold_cents) || 0;
  const total = (Number(data.unit_price_cents) || 0) * (Number(data.quantity) || 0);
  return total > threshold || data.unit_price_cents == null;
}

// Validate and shape a new order from a request body. Does not write anything.
// Returns the row data for insertOrder, including approval and a forced 'needed' status while pending.
export function buildOrderData(user, body, settings) {
  const fields = isAtLeast(user, 'mentor') ? ORDER_FIELDS : STUDENT_ORDER_FIELDS;
  const data = pick(body, fields);
  if (!data.name) throw new HttpError(400, 'Part name required');
  if (data.status && !STATUSES.includes(data.status)) data.status = 'needed';
  data.created_by = user.id;
  if (!data.requested_by) data.requested_by = user.display_name;
  data.approval = needsApproval(user, data, settings) ? 'pending' : 'approved';
  if (data.approval === 'pending') data.status = 'needed';
  return data;
}

// Validate a student's edit to an order. Returns the data to write, plus a flag saying the
// order must be re-approved (a sensitive field changed, or it was rejected and is being resubmitted).
export function buildOrderPatch(user, order, body, isMentor, settings) {
  const data = pick(body, isMentor ? ORDER_FIELDS : STUDENT_ORDER_FIELDS);
  if (data.status && !STATUSES.includes(data.status)) throw new HttpError(400, 'Bad status');
  if (data.status && data.status !== 'needed' && order.approval !== 'approved' && !('approval' in body)) {
    throw new HttpError(400, 'This request has not been approved yet.');
  }
  if (!isMentor) {
    const merged = { ...order, ...data };
    const changed = APPROVAL_SENSITIVE.some((k) => k in data && String(data[k] ?? '') !== String(order[k] ?? ''));
    if ((changed || order.approval === 'rejected') && needsApproval(user, merged, settings)) {
      Object.assign(data, { approval: 'pending', approved_by: null, approved_at: null, rejection_reason: null });
    }
  }
  return data;
}

// Next sort value for a card dropped in a column. `cards` are the other cards in the column, sorted.
// beforeId = the card it lands in front of; missing or unknown means the end of the column.
export function computeCardSort(cards, beforeId) {
  const beforeIdx = beforeId ? cards.findIndex((c) => c.id === Number(beforeId)) : -1;
  if (beforeIdx < 0) return (cards.at(-1)?.sort ?? 0) + 1;
  if (beforeIdx === 0) return cards[0].sort - 1;
  return (cards[beforeIdx - 1].sort + cards[beforeIdx].sort) / 2;
}

const CSV_COLUMNS = ['id', 'status', 'approval', 'name', 'supplier', 'sku', 'quantity', 'unit_price', 'total', 'mechanism', 'priority',
  'requested_by', 'approved_by', 'order_number', 'tracking_number', 'url', 'notes', 'created_at', 'ordered_at', 'arrived_at'];

const csvEscape = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

// Orders as CSV. `mechanisms` maps mechanism id -> name. Prices are stored in cents.
export function ordersToCsv(rows, mechanisms) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    const unit = r.unit_price_cents != null ? (r.unit_price_cents / 100).toFixed(2) : '';
    const total = r.unit_price_cents != null ? ((r.unit_price_cents * r.quantity) / 100).toFixed(2) : '';
    lines.push(CSV_COLUMNS.map((c) => csvEscape(
      c === 'unit_price' ? unit : c === 'total' ? total : c === 'mechanism' ? mechanisms[r.mechanism_id] : r[c],
    )).join(','));
  }
  return lines.join('\n');
}

// Uploaded part-file name: basename only, control characters and quotes removed, max 200 characters.
// Returns { name, ext } or null when the extension isn't an allowed part-file type.
export function parsePartFileName(raw) {
  const name = path.basename(String(raw || '')).replace(/[\u0000-\u001f"]/g, '').slice(0, 200);
  if (!name) return null;
  const ext = name.split('.').pop().toLowerCase();
  return FILE_TYPES.includes(ext) ? { name, ext } : null;
}

// Detect the image type from its first bytes (don't trust the name or header).
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  return Object.values(IMAGE_TYPES).find((t) => t.magic(buf)) || null;
}

// True for addresses on this machine or the local network (the image-link fetcher must not reach them).
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

// A supplier is "built in" if its key or name matches (case-insensitive).
export function isBuiltInSupplier(name, builtIn) {
  const n = name.toLowerCase();
  return builtIn.some((s) => s.key === n || s.name.toLowerCase() === n);
}
