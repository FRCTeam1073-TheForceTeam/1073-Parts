// Helpers that seed data through the HTTP API (never SQL). Names come from uniq(), so reruns don't collide.
// Each helper throws with the server's error text if the call fails, so a broken setup fails loudly.
// Runs of uniq() in the same process never repeat. The random run id keeps names apart across reruns.
const RUN_ID = Math.random().toString(36).slice(2, 8);
let counter = 0;
export function uniq(prefix) {
  counter += 1;
  return `${prefix}-${RUN_ID}-${counter}`;
}

// Creates a member through the admin's API and returns the login details, so a test can sign in as them.
// Use it for any test that changes a password or disables an account, so the shared role logins stay valid.
export async function createMember(adminApi, { role = 'student', name } = {}) {
  const account = {
    username: uniq('e2e-user').toLowerCase(),
    display_name: name ?? uniq('E2E Member'),
    password: 'e2e-member-pass',
    role,
  };
  const res = await adminApi.post('/api/users', { data: account });
  if (!res.ok()) throw new Error(`createMember failed: HTTP ${res.status()} ${await res.text()}`);
  return { ...account, id: (await res.json()).id };
}

async function ok(res, what) {
  if (!res.ok()) throw new Error(`${what} failed: HTTP ${res.status()} ${await res.text()}`);
  return res.json();
}

// Any signed-in member can add a vendor. Returns the vendor's saved name.
export async function createVendor(api, name = uniq('E2E Vendor')) {
  const vendor = await ok(await api.post('/api/vendors', { data: { name } }), 'create vendor');
  return vendor.name;
}

// Adds a part request through the API (the same data the Add part form sends).
export async function createRequest(api, { name = uniq('E2E Part'), supplier, quantity = 1, unit_price_cents = 500 } = {}) {
  return ok(await api.post('/api/orders', {
    data: { name, supplier, quantity, unit_price_cents, priority: 'normal' },
  }), 'create request');
}

// Changes settings and returns the previous values, so a test can put them back.
export async function setSettings(api, patch) {
  const meta = await ok(await api.get('/api/meta'), 'read settings');
  const previous = {};
  for (const key of Object.keys(patch)) previous[key] = meta.settings[key];
  await ok(await api.put('/api/settings', { data: patch }), 'save settings');
  return previous;
}

// Reads the current value of the named settings, so a test can put exactly those values back.
export async function readSettings(api, keys) {
  const meta = await ok(await api.get('/api/meta'), 'read settings');
  return Object.fromEntries(keys.map((key) => [key, meta.settings[key]]));
}
