// Starts the real server (server/start.js) on E2E_PORT, using the temp DATA_DIR that playwright.config.js
// created (E2E_DATA_DIR). Playwright runs this as its webServer. The folder is removed by global-teardown.js,
// not here, because Playwright stops this process with signals that are not always delivered.
// It never reads DATA_DIR, SETUP_CODE or TRUST_PROXY from the caller's environment, so the team's live
// database in data/ can't be touched from here.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const liveDataDir = path.join(repoRoot, 'data');

const port = Number(process.env.E2E_PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error('E2E_PORT must be set by playwright.config.js');

const dataDir = path.resolve(process.env.E2E_DATA_DIR || '');
if (!process.env.E2E_DATA_DIR) throw new Error('E2E_DATA_DIR must be set by playwright.config.js');
if (dataDir === liveDataDir || dataDir.startsWith(liveDataDir + path.sep)) {
  throw new Error(`Refusing to run e2e against the live database folder: ${dataDir}`);
}

// Only the setup code the run asks for (E2E_SETUP_CODE, used by the first-run config) reaches the server.
const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, SETUP_CODE: process.env.E2E_SETUP_CODE || '' };
delete env.TRUST_PROXY;

const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/start.js'], {
  cwd: repoRoot,
  env,
  stdio: ['ignore', 'inherit', 'inherit'],
});

// Stop the server when this helper is told to stop. The temp folder is handled by global-teardown.js.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    child.kill('SIGTERM');
    process.exit(0);
  });
}
child.on('exit', (code) => process.exit(code ?? 1));
