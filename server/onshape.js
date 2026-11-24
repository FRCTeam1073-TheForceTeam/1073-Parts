// Onshape: read an assembly's bill of materials (or a Part Studio's parts) from a document link.
// Uses the team's API keys (Settings → Onshape), sent with HTTP Basic auth as Onshape allows.
import { db } from './db.js';

const BASE = 'https://cad.onshape.com';
const KEY_ACCESS = 'onshape_access_key';
const KEY_SECRET = 'onshape_secret_key';

const readSecret = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';

export function isConfigured() {
  return !!(readSecret(KEY_ACCESS) && readSecret(KEY_SECRET));
}

export function saveKeys(access, secret) {
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  up.run(KEY_ACCESS, String(access || '').trim());
  up.run(KEY_SECRET, String(secret || '').trim());
}

// https://cad.onshape.com/documents/<did>/<w|v|m>/<wvmid>/e/<eid>
export function parseUrl(url) {
  const m = String(url || '').match(/onshape\.com\/documents\/([0-9a-f]{24})\/([wvm])\/([0-9a-f]{24})\/e\/([0-9a-f]{24})/i);
  if (!m) return null;
  return { did: m[1], wvm: m[2], wvmid: m[3], eid: m[4] };
}

async function get(path) {
  const access = readSecret(KEY_ACCESS);
  const secret = readSecret(KEY_SECRET);
  if (!access || !secret) {
    const err = new Error('Onshape is not connected yet. An admin can add API keys under Settings → Onshape.');
    err.status = 400;
    throw err;
  }
  const res = await fetch(BASE + path, {
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${access}:${secret}`).toString('base64'),
      Accept: 'application/json;charset=UTF-8; qs=0.09',
    },
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error(res.status === 401
      ? 'Onshape rejected the API keys. Check them under Settings → Onshape.'
      : "The Onshape account behind the API keys can't open that document. Share it with that account (or make it public).");
    err.status = 400;
    throw err;
  }
  if (res.status === 404) {
    const err = new Error("Onshape couldn't find that document or tab. Copy the link again from the browser address bar.");
    err.status = 400;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Onshape responded ${res.status}`);
    err.status = res.status >= 500 ? 502 : 400;
    throw err;
  }
  const body = await res.text();
  return body ? JSON.parse(body) : null;
}

// sessioninfo answers 204 (not 401) for bad keys, so check with a call that requires them.
export async function testConnection() {
  await get('/api/v9/documents?limit=1');
  const info = await get('/api/v9/users/sessioninfo').catch(() => null);
  return { name: info?.name || info?.email || 'your Onshape account' };
}

const docUrl = ({ did, wvm, wvmid, eid }) => `${BASE}/documents/${did}/${wvm}/${wvmid}/e/${eid}`;
const text = (v) => (v == null ? '' : typeof v === 'object' ? String(v.displayName ?? v.name ?? v.value ?? '') : String(v)).trim();

// Returns [{ partNumber, name, description, material, qty, cadUrl }] like a CSV BOM row.
export async function fetchParts(url) {
  const ref = parseUrl(url);
  if (!ref) {
    const err = new Error('That is not an Onshape document link. Open the assembly in Onshape and copy the address bar.');
    err.status = 400;
    throw err;
  }
  const { did, wvm, wvmid, eid } = ref;

  // Assemblies have a BOM. A flattened BOM gives one row per unique part with total quantity.
  try {
    const bom = await get(`/api/v9/assemblies/d/${did}/${wvm}/${wvmid}/e/${eid}/bom?indented=false&multiLevel=false&generateIfAbsent=true`);
    const byProp = {};
    for (const hdr of bom.headers || []) byProp[hdr.propertyName || hdr.name] = hdr.id;
    const col = (row, ...props) => {
      for (const p of props) if (byProp[p] && row.headerIdToValue?.[byProp[p]] != null) return row.headerIdToValue[byProp[p]];
      return null;
    };
    return (bom.rows || []).map((row) => {
      const src = row.itemSource || {};
      return {
        partNumber: text(col(row, 'partNumber', 'Part number')),
        name: text(col(row, 'name', 'Name')),
        description: text(col(row, 'description', 'Description')),
        material: text(col(row, 'material', 'Material')),
        qty: Math.max(1, Math.round(Number(col(row, 'quantity', 'Quantity')) || 1)),
        cadUrl: src.documentId && src.elementId
          ? docUrl({ did: src.documentId, wvm: src.wvmType || wvm, wvmid: src.wvmId || wvmid, eid: src.elementId })
          : docUrl(ref),
      };
    }).filter((r) => r.partNumber || r.name);
  } catch (err) {
    if (!/couldn't find/.test(err.message)) throw err;
  }

  // Not an assembly: read the Part Studio's parts (one of each).
  const parts = await get(`/api/v9/parts/d/${did}/${wvm}/${wvmid}/e/${eid}`);
  return (parts || []).filter((p) => !p.isHidden).map((p) => ({
    partNumber: text(p.partNumber),
    name: text(p.name),
    description: text(p.description),
    material: text(p.material),
    qty: 1,
    cadUrl: docUrl(ref),
  }));
}
