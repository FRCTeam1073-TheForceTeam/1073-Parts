// Fetching a picture from a pasted link (server/app.js fetchPublicImage). DNS and fetch are stubbed,
// so these never touch the network. The point is what gets refused.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/app-harness.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]);
const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

function response(status, { headers = {}, body = Buffer.alloc(0) } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    arrayBuffer: async () => body,
  };
}

// Feed the fetcher a script of responses, one per hop. Records each URL requested.
function scripted(responses) {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch');
    return next;
  };
  return { fetchImpl, requested };
}

describe('fetching a picture from a link', () => {
  let h;
  let fetchPublicImage;
  before(async () => {
    h = await startHarness();
    fetchPublicImage = h.built.fetchPublicImage;
  });
  after(() => h.close());

  it('refuses text that is not a link', async () => {
    await assert.rejects(fetchPublicImage('not a url'), (err) => err.status === 400 && err.message === "That isn't a link to an image.");
  });

  it('refuses links that are not http or https', async () => {
    await assert.rejects(fetchPublicImage('ftp://example.com/a.png'), /Only web \(http\/https\) image links work\./);
  });

  it('refuses a host that resolves to a private address (the school network is off limits)', async () => {
    const { fetchImpl, requested } = scripted([]);
    const lookup = async () => [{ address: '192.168.1.20', family: 4 }];
    await assert.rejects(fetchPublicImage('https://printer.local/a.png', { lookup, fetchImpl }), /couldn't be reached/);
    assert.deepEqual(requested, [], 'nothing is fetched');
  });

  it('refuses a host where any one address is private', async () => {
    const lookup = async () => [...PUBLIC, { address: '127.0.0.1', family: 4 }];
    await assert.rejects(fetchPublicImage('https://mixed.example/a.png', { lookup, fetchImpl: scripted([]).fetchImpl }), /couldn't be reached/);
  });

  it('refuses a host that does not resolve', async () => {
    const lookup = async () => { throw new Error('ENOTFOUND'); };
    await assert.rejects(fetchPublicImage('https://nowhere.example/a.png', { lookup, fetchImpl: scripted([]).fetchImpl }), /couldn't be reached/);
  });

  it('checks the address of the host it was asked about', async () => {
    const seen = [];
    const lookup = async (host) => { seen.push(host); return PUBLIC; };
    const { fetchImpl } = scripted([response(200, { body: PNG })]);
    await fetchPublicImage('https://images.example.org/x.png', { lookup, fetchImpl });
    assert.deepEqual(seen, ['images.example.org']);
  });

  it('returns the bytes of a picture found at a public link', async () => {
    const { fetchImpl } = scripted([response(200, { body: PNG })]);
    const buf = await fetchPublicImage('https://example.com/a.png', { lookup: async () => PUBLIC, fetchImpl });
    assert.deepEqual(buf, PNG);
  });

  it('follows a relative redirect, checking the new host each time', async () => {
    const hosts = [];
    const lookup = async (host) => { hosts.push(host); return PUBLIC; };
    const { fetchImpl, requested } = scripted([
      response(301, { headers: { location: '/images/final.png' } }),
      response(200, { body: PNG }),
    ]);
    const buf = await fetchPublicImage('https://shop.example.com/redirect', { lookup, fetchImpl });
    assert.deepEqual(buf, PNG);
    assert.equal(requested[1], 'https://shop.example.com/images/final.png');
    assert.deepEqual(hosts, ['shop.example.com', 'shop.example.com']);
  });

  it('stops after four redirects', async () => {
    const loop = Array.from({ length: 5 }, () => response(302, { headers: { location: 'https://example.com/again' } }));
    const { fetchImpl, requested } = scripted(loop);
    await assert.rejects(fetchPublicImage('https://example.com/start', { lookup: async () => PUBLIC, fetchImpl }), /redirects too many times/);
    assert.equal(requested.length, 4);
  });

  it('will not follow a redirect into a private address', async () => {
    const lookup = async (host) => (host === 'evil.example' ? [{ address: '10.0.0.7', family: 4 }] : PUBLIC);
    const { fetchImpl, requested } = scripted([response(302, { headers: { location: 'https://evil.example/secret.png' } })]);
    await assert.rejects(fetchPublicImage('https://example.com/go', { lookup, fetchImpl }), /couldn't be reached/);
    assert.equal(requested.length, 1, 'the private target is never requested');
  });

  it('reports a website error status', async () => {
    const { fetchImpl } = scripted([response(404)]);
    await assert.rejects(fetchPublicImage('https://example.com/a.png', { lookup: async () => PUBLIC, fetchImpl }), /responded 404/);
  });

  it('refuses a picture that announces itself as larger than 8 MB', async () => {
    const { fetchImpl } = scripted([response(200, { headers: { 'content-length': String(9 * 1024 * 1024) } })]);
    await assert.rejects(fetchPublicImage('https://example.com/huge.png', { lookup: async () => PUBLIC, fetchImpl }), /over 8 MB/);
  });

  it('refuses a picture over 8 MB even when it does not announce its size', async () => {
    const { fetchImpl } = scripted([response(200, { body: Buffer.alloc(8 * 1024 * 1024 + 1) })]);
    await assert.rejects(fetchPublicImage('https://example.com/huge.png', { lookup: async () => PUBLIC, fetchImpl }), /over 8 MB/);
  });
});
