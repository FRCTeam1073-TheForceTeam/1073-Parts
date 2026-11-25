// Onshape logic with no database import: URL parsing, BOM mapping, and an API client that takes
// its keys and fetch as parameters. onshape.js wires these to the real settings table.

export const BASE = 'https://cad.onshape.com';

// https://cad.onshape.com/documents/<did>/<w|v|m>/<wvmid>/e/<eid>
export function parseUrl(url) {
  const m = String(url || '').match(/onshape\.com\/documents\/([0-9a-f]{24})\/([wvm])\/([0-9a-f]{24})\/e\/([0-9a-f]{24})/i);
  if (!m) return null;
  return { did: m[1], wvm: m[2], wvmid: m[3], eid: m[4] };
}

export const docUrl = ({ did, wvm, wvmid, eid }) => `${BASE}/documents/${did}/${wvm}/${wvmid}/e/${eid}`;

export const text = (v) => (v == null ? '' : typeof v === 'object' ? String(v.displayName ?? v.name ?? v.value ?? '') : String(v)).trim();

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Map an assembly BOM response to CSV-shaped rows: [{ partNumber, name, description, material, qty, cadUrl }].
export function bomRowsToParts(bom, ref) {
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
        ? docUrl({ did: src.documentId, wvm: src.wvmType || ref.wvm, wvmid: src.wvmId || ref.wvmid, eid: src.elementId })
        : docUrl(ref),
    };
  }).filter((r) => r.partNumber || r.name);
}

// Map a Part Studio's parts to rows (one of each, hidden parts left out).
export function partStudioToParts(parts, ref) {
  return (parts || []).filter((p) => !p.isHidden).map((p) => ({
    partNumber: text(p.partNumber),
    name: text(p.name),
    description: text(p.description),
    material: text(p.material),
    qty: 1,
    cadUrl: docUrl(ref),
  }));
}

// `getKeys()` returns { access, secret }. `fetchImpl` defaults to the global fetch.
export function createOnshapeClient({ getKeys, fetchImpl = (...args) => fetch(...args) }) {
  const isConfigured = () => {
    const { access, secret } = getKeys();
    return !!(access && secret);
  };

  async function get(path) {
    const { access, secret } = getKeys();
    if (!access || !secret) {
      throw httpError('Onshape is not connected yet. An admin can add API keys under Settings → Onshape.', 400);
    }
    const res = await fetchImpl(BASE + path, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${access}:${secret}`).toString('base64'),
        Accept: 'application/json;charset=UTF-8; qs=0.09',
      },
    });
    if (res.status === 401 || res.status === 403) {
      throw httpError(res.status === 401
        ? 'Onshape rejected the API keys. Check them under Settings → Onshape.'
        : "The Onshape account behind the API keys can't open that document. Share it with that account (or make it public).", 400);
    }
    if (res.status === 404) {
      throw httpError("Onshape couldn't find that document or tab. Copy the link again from the browser address bar.", 400);
    }
    if (!res.ok) {
      throw httpError(`Onshape responded ${res.status}`, res.status >= 500 ? 502 : 400);
    }
    const body = await res.text();
    return body ? JSON.parse(body) : null;
  }

  // sessioninfo answers 204 (not 401) for bad keys, so check with a call that requires them.
  async function testConnection() {
    await get('/api/v9/documents?limit=1');
    const info = await get('/api/v9/users/sessioninfo').catch(() => null);
    return { name: info?.name || info?.email || 'your Onshape account' };
  }

  // Returns CSV-shaped rows for an assembly (BOM) or, if that isn't an assembly, a Part Studio.
  async function fetchParts(url) {
    const ref = parseUrl(url);
    if (!ref) throw httpError('That is not an Onshape document link. Open the assembly in Onshape and copy the address bar.', 400);
    const { did, wvm, wvmid, eid } = ref;

    // Assemblies have a BOM. A flattened BOM gives one row per unique part with total quantity.
    try {
      const bom = await get(`/api/v9/assemblies/d/${did}/${wvm}/${wvmid}/e/${eid}/bom?indented=false&multiLevel=false&generateIfAbsent=true`);
      return bomRowsToParts(bom, ref);
    } catch (err) {
      if (!/couldn't find/.test(err.message)) throw err;
    }

    const parts = await get(`/api/v9/parts/d/${did}/${wvm}/${wvmid}/e/${eid}`);
    return partStudioToParts(parts, ref);
  }

  return { isConfigured, get, testConnection, fetchParts };
}
