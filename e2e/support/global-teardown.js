// Runs once after all specs, in the main Playwright process. Deletes the temp DATA_DIR made for this run.
import fs from 'node:fs';

export default async function globalTeardown() {
  const dir = process.env.E2E_DATA_DIR;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}
