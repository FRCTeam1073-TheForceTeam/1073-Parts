# Agent guide: 1073 Parts

Team parts ordering, inventory, and build-board app. Node 22.13+, ES modules (`"type": "module"`), Express 4, built-in `node:sqlite`, vanilla browser JS in `public/js/`. No build step, no TypeScript, no test framework beyond `node:test`.

## Commands

| Command | What it runs |
| --- | --- |
| `npm run test:unit` | Unit tests in `test/unit/`. No database. A loader hook makes `node:sqlite`, `server/db.js` and `server/data.js` throw on import. |
| `npm run test:db` | Database integration tests in `test/db/`. Each file gets a throwaway database in a temp `DATA_DIR`. |
| `npm test` | Both suites. |
| `npm run test:coverage` | Unit suite with coverage. |
| `npm run test:e2e` | Playwright end-to-end tests in `e2e/`. Starts its own server and database. See `e2e/AGENTS.md`. |

Run the relevant suite before reporting work as done. Report failures with their output; don't describe a suite as passing unless it did.

## Git

Do not run `git add`, `git commit`, or `git push` unless the user explicitly asks. The user handles commits. Leave changes in the working tree.

## Architecture rules

The code is split so that business logic can be tested without a database. Keep these boundaries.

1. **Database code stays in the database layer.** SQL and `node:sqlite` belong in `server/db.js` (connection and schema) and `server/data.js` (queries). Nothing else opens a database or writes SQL. `server/backup.js` is the one exception, for its `VACUUM INTO` snapshot, and it is isolated for that reason. If new code needs data, add a function to `data.js` and call it through an injected dependency, not by importing `data.js` from a module that unit tests load.

2. **Pure logic lives in modules that import nothing stateful.** Validation, approval rules, sorting, CSV building, parsing, and formatting go in pure functions. Put new order, board, or upload rules in `server/logic.js`. Put account rules in `server/auth-core.js`, and Onshape logic in `server/onshape-core.js`. A module that only holds pure code must not import `data.js`, `db.js`, `auth.js`, or `onshape.js`, because those open the database on import.

3. **Routes receive their dependencies.** `server/app.js` exports `createApp({ store, auth, suppliers, onshape, createBackup, dataDir, setupCode, trustProxy, projectRoot })`. It must not import `data.js`, `auth.js`, `onshape.js`, or anything that opens the database. Only `server/index.js` wires in the real modules. New route dependencies are added as parameters.

4. **Side effects happen at the edges.** Reading environment variables, opening files, starting the server, and signal handlers belong in `server/index.js` or `server/start.js`. Functions that take inputs and return outputs should not read `process.env`, `Date.now()` without an override, or the filesystem directly. Pass these in, for example a `now` function or a `dataDir`.

5. **Browser modules.** `public/js/core.js` can be imported in Node because it touches the DOM only inside functions. Keep new pure helpers free of DOM calls, and export helpers that a test needs. DOM wiring (event handlers, building elements) is not unit tested.

## Writing tests

**Pick the suite by what the test touches.**

- Calls a pure function, a route with a fake store, or a browser helper: write it in `test/unit/`.
- Needs real SQL, schema, migrations, or transactions: write it in `test/db/`. Use `openTestDb()` from `test/db/helpers/db.js` and the fixtures in `test/db/helpers/fixtures.js`.
- A unit test that fails with "must not load the database" has reached for the database. Fix the design: move the logic into a pure function or inject a fake. Do not move the test into `test/db/` just to make it pass, unless the test really needs SQL.

**Unit test conventions**

- Use `node:test` (`describe`, `it`, `before`, `after`, `beforeEach`) and `node:assert/strict`.
- File names: `<area>.test.js`, flat in `test/unit/`.
- Fakes and harnesses live in `test/unit/helpers/`. Use `makeFakeStore()` for route tests and `startHarness()` to run `createApp` on an ephemeral port. If a route needs a store method the fake lacks, add it to `fake-store.js` and record the write in `calls`.
- Stub the network by replacing `globalThis.fetch` (restore it in `afterEach`) or by passing `fetchImpl`. Never make real network requests. Call `clearCache()` after tests that touch `suppliers.js`.
- Stub time with an injected `now` function, not by changing `Date`.
- Every test should check one behaviour and say what it is in its name, for example `it('refuses a host that resolves to a private address')`.

**Every new behaviour needs a test.** That includes new routes, new validation, new error messages, and changes to existing rules. For a bug fix, add a test that fails without the fix. When you add a route, test its status codes, its permission check (a request from a lower role gets 403), and its error paths.

**Do not test wiring-only code** such as `index.js` startup, event handler binding, and markup. Test the logic those pieces call.

## Writing code that can be tested

- Keep functions small and take everything they need as arguments.
- Return values rather than writing to a global or to `res`, unless the function is a route handler.
- Put rules in pure functions and keep Express handlers thin: read the request, call the pure rule, call the store, send the response.
- Throw `HttpError` (from `server/logic.js`) with a `status` for errors that map to an HTTP response. `wrap()` in `app.js` turns it into a JSON response.
- Do not add module-level mutable state without a way to reset it in tests. The login throttle exposes `createLoginThrottle()` for this reason. The supplier fetch cache exposes `clearCache()`.
- When you add an export only so a test can reach it, that is fine. Keep the export list in the module small.

## Project layout

```
server/
  index.js          entry point: wires real dependencies, startup housekeeping, listen
  app.js            createApp(): Express routes, injected dependencies
  logic.js          pure order, board, CSV, upload and address rules
  auth-core.js      pure password, role and throttle rules
  auth.js           sessions and cookies (uses data.js)
  data.js           every SQL query (uses db.js)
  db.js             connection, schema, migrations, seed data
  suppliers.js      supplier search, product parsing, cart building
  onshape-core.js   pure Onshape logic and API client
  onshape.js        Onshape wired to saved keys (uses data.js)
  backup-archive.js tar format and restore (no database)
  backup.js         database snapshot and CLI (uses node:sqlite)
  start.js          restore-on-boot script
public/js/          browser modules (core.js holds shared helpers and state)
test/unit/          unit tests and test/unit/helpers/ (fakes, harness, DB-blocking loader)
test/db/            database tests and test/db/helpers/
e2e/                Playwright end-to-end tests (own guide: e2e/AGENTS.md)
```

## Before you finish

- Confirm the new logic is in a module the unit suite can load, or that the test is in `test/db/` for a real reason.
- Run `npm run test:unit`, and `npm run test:db` if you touched SQL, `data.js`, or `db.js`.
- Check that unit tests did not need `DATA_DIR` or a real database.
- Do not commit.
