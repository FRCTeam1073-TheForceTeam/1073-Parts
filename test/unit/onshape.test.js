// Onshape link parsing, BOM mapping and the API client (server/onshape-core.js). Keys and fetch are stubbed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseUrl, bomRowsToParts, partStudioToParts, createOnshapeClient, docUrl } from '../../server/onshape-core.js';

const DID = 'a'.repeat(24);
const WID = 'b'.repeat(24);
const EID = 'c'.repeat(24);
const ASSEMBLY_URL = `https://cad.onshape.com/documents/${DID}/w/${WID}/e/${EID}`;

const json = (status, body) => ({
  status, ok: status >= 200 && status < 300, text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

// Answers each request by path prefix. A path with no answer fails the test loudly.
function fakeOnshape(answers) {
  const requested = [];
  const fetchImpl = async (url, init) => {
    const path = String(url).replace('https://cad.onshape.com', '');
    requested.push({ path, auth: init.headers.Authorization });
    const key = Object.keys(answers).find((k) => path.startsWith(k));
    if (!key) throw new Error(`unexpected request ${path}`);
    const answer = answers[key];
    return typeof answer === 'function' ? answer(path) : answer;
  };
  return { fetchImpl, requested };
}

describe('Onshape links', () => {
  it('reads the document, workspace, version and element ids from a link', () => {
    assert.deepEqual(parseUrl(ASSEMBLY_URL), { did: DID, wvm: 'w', wvmid: WID, eid: EID });
  });

  it('accepts version and microversion links', () => {
    assert.equal(parseUrl(`https://cad.onshape.com/documents/${DID}/v/${WID}/e/${EID}`).wvm, 'v');
    assert.equal(parseUrl(`https://cad.onshape.com/documents/${DID}/m/${WID}/e/${EID}`).wvm, 'm');
  });

  it('returns null for anything that is not a complete document link', () => {
    assert.equal(parseUrl('https://cad.onshape.com/documents/short'), null);
    assert.equal(parseUrl('https://example.com/whatever'), null);
    assert.equal(parseUrl(undefined), null);
  });

  it('builds a document link from its parts', () => {
    assert.equal(docUrl({ did: DID, wvm: 'w', wvmid: WID, eid: EID }), ASSEMBLY_URL);
  });
});

describe('BOM mapping', () => {
  const ref = { did: DID, wvm: 'w', wvmid: WID, eid: EID };
  const bom = {
    headers: [
      { id: 'h1', propertyName: 'partNumber' },
      { id: 'h2', propertyName: 'name' },
      { id: 'h3', propertyName: 'description' },
      { id: 'h4', propertyName: 'material' },
      { id: 'h5', name: 'Quantity' },
    ],
    rows: [
      { headerIdToValue: { h1: 'PN-1', h2: { displayName: 'Shaft' }, h3: '', h4: 'Steel', h5: 3 }, itemSource: { documentId: 'd2', elementId: 'e2', wvmType: 'v', wvmId: 'x' } },
      { headerIdToValue: { h1: '', h2: 'Washer', h5: 0 } },
      { headerIdToValue: { h1: '', h2: '' } },
      { headerIdToValue: { h1: 'PN-9', h2: 'Frame', h5: '2.6' } },
    ],
  };

  it('maps header ids to names, clamps quantities to at least 1 and drops empty rows', () => {
    const parts = bomRowsToParts(bom, ref);
    assert.equal(parts.length, 3, 'the all-empty row is dropped');
    assert.equal(parts[0].partNumber, 'PN-1');
    assert.equal(parts[0].name, 'Shaft', 'object values use displayName');
    assert.equal(parts[0].qty, 3);
    assert.equal(parts[1].qty, 1, 'zero quantity becomes 1');
    assert.equal(parts[2].qty, 3, '2.6 rounds to 3');
  });

  it('links each row to its own document when the row names one', () => {
    const parts = bomRowsToParts(bom, ref);
    assert.equal(parts[0].cadUrl, docUrl({ did: 'd2', wvm: 'v', wvmid: 'x', eid: 'e2' }));
    assert.equal(parts[1].cadUrl, docUrl(ref));
  });

  it('handles a BOM with no headers or rows', () => {
    assert.deepEqual(bomRowsToParts({}, ref), []);
  });

  it('maps a Part Studio, leaving out hidden parts', () => {
    const parts = partStudioToParts([
      { partNumber: ' P1 ', name: 'Plate', description: 'd', material: 'Al' },
      { partNumber: 'P2', name: 'Hidden', isHidden: true },
    ], ref);
    assert.equal(parts.length, 1);
    assert.deepEqual(parts[0], { partNumber: 'P1', name: 'Plate', description: 'd', material: 'Al', qty: 1, cadUrl: docUrl(ref) });
  });
});

describe('Onshape client', () => {
  it('is not configured until both keys are present', () => {
    assert.equal(createOnshapeClient({ getKeys: () => ({ access: 'a', secret: '' }) }).isConfigured(), false);
    assert.equal(createOnshapeClient({ getKeys: () => ({ access: 'a', secret: 's' }) }).isConfigured(), true);
  });

  it('asks you to connect first when there are no keys', async () => {
    const client = createOnshapeClient({ getKeys: () => ({ access: '', secret: '' }), fetchImpl: () => assert.fail('no request') });
    await assert.rejects(client.get('/api/v9/documents'), (err) => err.status === 400 && /not connected/.test(err.message));
  });

  it('sends the keys as HTTP Basic auth', async () => {
    const { fetchImpl, requested } = fakeOnshape({ '/api/v9/documents': json(200, []) });
    const client = createOnshapeClient({ getKeys: () => ({ access: 'AK', secret: 'SK' }), fetchImpl });
    await client.get('/api/v9/documents');
    assert.equal(requested[0].auth, 'Basic ' + Buffer.from('AK:SK').toString('base64'));
  });

  it('explains a rejected key and a document the account cannot open', async () => {
    const keys = { getKeys: () => ({ access: 'a', secret: 's' }) };
    const rejected = createOnshapeClient({ ...keys, fetchImpl: fakeOnshape({ '/': json(401) }).fetchImpl });
    await assert.rejects(rejected.get('/api/v9/x'), /rejected the API keys/);
    const forbidden = createOnshapeClient({ ...keys, fetchImpl: fakeOnshape({ '/': json(403) }).fetchImpl });
    await assert.rejects(forbidden.get('/api/v9/x'), /can't open that document/);
  });

  it('reports a missing document as a 400 and a server error as a 502', async () => {
    const keys = { getKeys: () => ({ access: 'a', secret: 's' }) };
    const missing = createOnshapeClient({ ...keys, fetchImpl: fakeOnshape({ '/': json(404) }).fetchImpl });
    await assert.rejects(missing.get('/api/v9/x'), (err) => err.status === 400 && /couldn't find/.test(err.message));
    const broken = createOnshapeClient({ ...keys, fetchImpl: fakeOnshape({ '/': json(503) }).fetchImpl });
    await assert.rejects(broken.get('/api/v9/x'), (err) => err.status === 502);
  });

  it('treats an empty success body as null', async () => {
    const client = createOnshapeClient({ getKeys: () => ({ access: 'a', secret: 's' }), fetchImpl: fakeOnshape({ '/': json(204) }).fetchImpl });
    assert.equal(await client.get('/api/v9/x'), null);
  });

  it('tests the connection and names the account', async () => {
    const { fetchImpl } = fakeOnshape({
      '/api/v9/documents': json(200, []),
      '/api/v9/users/sessioninfo': json(200, { name: 'Robot Team' }),
    });
    const client = createOnshapeClient({ getKeys: () => ({ access: 'a', secret: 's' }), fetchImpl });
    assert.deepEqual(await client.testConnection(), { name: 'Robot Team' });
  });

  it('still connects when the session info is unavailable', async () => {
    const { fetchImpl } = fakeOnshape({
      '/api/v9/documents': json(200, []),
      '/api/v9/users/sessioninfo': json(500),
    });
    const client = createOnshapeClient({ getKeys: () => ({ access: 'a', secret: 's' }), fetchImpl });
    assert.deepEqual(await client.testConnection(), { name: 'your Onshape account' });
  });

  it('rejects a link that is not an Onshape document before asking Onshape anything', async () => {
    const client = createOnshapeClient({ getKeys: () => ({ access: 'a', secret: 's' }), fetchImpl: () => assert.fail('no request') });
    await assert.rejects(client.fetchParts('https://example.com/nope'), /not an Onshape document link/);
  });

  it('returns the assembly BOM when the link is an assembly', async () => {
    const bom = { headers: [{ id: 'h1', propertyName: 'partNumber' }], rows: [{ headerIdToValue: { h1: 'PN-7' } }] };
    const { fetchImpl, requested } = fakeOnshape({ '/api/v9/assemblies/': json(200, bom) });
    const client = createOnshapeClient({ getKeys: () => ({ access: 'a', secret: 's' }), fetchImpl });
    const parts = await client.fetchParts(ASSEMBLY_URL);
    assert.equal(parts[0].partNumber, 'PN-7');
    assert.equal(requested.length, 1);
  });

  it('falls back to the Part Studio when the link is not an assembly', async () => {
    const { fetchImpl, requested } = fakeOnshape({
      '/api/v9/assemblies/': json(404),
      '/api/v9/parts/': json(200, [{ partNumber: 'PS-1', name: 'Part' }]),
    });
    const client = createOnshapeClient({ getKeys: () => ({ access: 'a', secret: 's' }), fetchImpl });
    const parts = await client.fetchParts(ASSEMBLY_URL);
    assert.equal(parts[0].partNumber, 'PS-1');
    assert.match(requested[1].path, /\/api\/v9\/parts\/d\//);
  });

  it('passes other errors through instead of falling back', async () => {
    const { fetchImpl, requested } = fakeOnshape({ '/api/v9/assemblies/': json(401) });
    const client = createOnshapeClient({ getKeys: () => ({ access: 'a', secret: 's' }), fetchImpl });
    await assert.rejects(client.fetchParts(ASSEMBLY_URL), /rejected the API keys/);
    assert.equal(requested.length, 1, 'no Part Studio request');
  });
});
