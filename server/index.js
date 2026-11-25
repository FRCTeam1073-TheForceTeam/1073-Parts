// Entry point: wires the real database, accounts, suppliers and Onshape into the app and starts listening.
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { db, dataDir } from './db.js'; // db is used only to close the connection on shutdown
import * as store from './data.js';
import * as suppliers from './suppliers.js';
import * as auth from './auth.js';
import * as onshape from './onshape.js';
import { createApp } from './app.js';
import { createBackup } from './backup.js';
import { isBuiltInSupplier } from './logic.js';

const PORT = Number(process.env.PORT) || 3000;

const { app, filesDir } = createApp({
  store,
  auth,
  suppliers,
  onshape,
  createBackup,
  dataDir,
  setupCode: process.env.SETUP_CODE || '',
  trustProxy: !!process.env.TRUST_PROXY,
});

// Startup housekeeping (kept out of createApp so tests don't touch real files or rows).
// Put supplier names typed on existing orders/inventory (before the vendor list existed) into the list.
for (const { supplier } of store.listSuppliersInUse()) {
  if (!isBuiltInSupplier(supplier, suppliers.SUPPLIERS)) store.ensureVendor(supplier);
}
// Uploads never attached to a part (window closed without saving) are cleared after a day.
for (const storedName of store.takeOrphanPartFiles()) {
  try {
    unlinkSync(path.join(filesDir, storedName));
  } catch {
    // already gone
  }
}

// Close the database cleanly when the host stops or restarts the app.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    try {
      db.close();
    } finally {
      process.exit(0);
    }
  });
}

app.listen(PORT, () => {
  console.log(`Parts tracker running at http://localhost:${PORT}`);
  if (auth.userCount() === 0) console.log('No accounts yet: open the site to create the first admin.');
});
