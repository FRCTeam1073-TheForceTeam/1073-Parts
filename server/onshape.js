// Onshape, wired to the team's saved API keys. The logic lives in onshape-core.js.
// Read an assembly's bill of materials (or a Part Studio's parts) from a document link.
// Keys are stored in the settings table and sent with HTTP Basic auth as Onshape allows.
import * as data from './data.js';
import { createOnshapeClient, parseUrl } from './onshape-core.js';

export { parseUrl };

const KEY_ACCESS = 'onshape_access_key';
const KEY_SECRET = 'onshape_secret_key';

const readSecret = (k) => data.getSetting(k) || '';

const client = createOnshapeClient({
  getKeys: () => ({ access: readSecret(KEY_ACCESS), secret: readSecret(KEY_SECRET) }),
});

export const isConfigured = client.isConfigured;
export const testConnection = client.testConnection;
export const fetchParts = client.fetchParts;

export function saveKeys(access, secret) {
  data.setSetting(KEY_ACCESS, String(access || '').trim());
  data.setSetting(KEY_SECRET, String(secret || '').trim());
}
