// Module resolve hook for unit tests: any attempt to load the database layer throws at import time.
// Blocks the SQLite binding itself and the two modules that wrap it, so a unit test can't touch data/.
const FORBIDDEN_FILE = /\/server\/(db|data)\.js$/;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:sqlite' || specifier === 'sqlite') {
    throw new Error(`Unit tests must not use the database (${specifier}). Move this test to test/db/.`);
  }
  const result = await nextResolve(specifier, context);
  if (FORBIDDEN_FILE.test(result.url)) {
    throw new Error(`Unit tests must not load the database (${specifier}). Move this test to test/db/ or pass a fake.`);
  }
  return result;
}
