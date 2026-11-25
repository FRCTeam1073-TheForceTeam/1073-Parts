# Agent guide: end-to-end tests (`e2e/`)

Playwright tests that drive the real app in a real browser against the real server. The unit suite (`test/unit/`) and database suite (`test/db/`) are separate. Do not move e2e tests into them, and do not import e2e code from them.

## Commands

| Command | What it runs |
| --- | --- |
| `npm run test:e2e` | All specs in `e2e/specs/`. Starts its own server on `E2E_PORT` (default 3100). |
| `npm run test:e2e:ui` | Same, in Playwright's UI mode, for debugging. |
| `npm run test:e2e:first-run` | First-run setup and setup-code tests (`e2e/first-run/`). They need a server with no accounts and a setup code, so they have their own config (`playwright.first-run.config.js`, port 3101). |

Run `npm run test:e2e` (and `npm run test:e2e:first-run` if you touched setup or login) before reporting e2e work as done. Report failures with their output. Do not describe the suite as passing unless it did.

## How a run works

1. `playwright.config.js` sets `E2E_PORT` (default 3100) and starts `e2e/support/serve.js` as the web server.
2. `playwright.config.js` creates an empty temp folder (`E2E_DATA_DIR`) for the run. `serve.js` starts `server/start.js` on `E2E_PORT` using that folder. It never reads `DATA_DIR`, `SETUP_CODE` or `TRUST_PROXY` from your shell and refuses to run against `data/`. `global-teardown.js` deletes the folder after the specs finish.
3. `e2e/support/global-setup.js` runs first-run setup through `POST /api/setup`, creates a mentor and a student, and saves each role's login to `e2e/.auth/<role>.json`.
4. Specs run against that server with one worker.

## Rules for writing specs

**Isolation**
- Never sign out, change a password, or disable a user on a shared role page (`adminPage`, `mentorPage`, `studentPage`). Sign-out ends the server session for that login, and later tests in the run would fail. Sign in through the form on `anonPage` instead. Create a throwaway account with `createMember()` (from `support/api.js`) for any test that changes a password or disables a user.
- A spec that changes a server setting (for example `require_approval`) must put it back in `afterAll`, and run serially (`test.describe.configure({ mode: 'serial' })`). Read the current values with `readSettings(api, [keys])` before changing them, then put exactly those values back with `setSettings()`. Don't call `setSettings(api, {})` to read values: it returns nothing useful, and a later restore then silently does nothing.
- Tests must not depend on each other or on run order. Create the data a test needs inside the test.
- Use `uniq('part')` (from `support/fixtures.js`) for every name, username and part number, so records from earlier tests never collide.
- Never write SQL, import `server/data.js` or `server/db.js`, or open `data/`. Seed through the HTTP API.

**Selectors and waiting**
- Shared helpers in `support/ui.js`: `openTab()` (nav buttons carry a count badge, so it matches the start of the label), `rowFor()` (a table row by its part name), `fillPartForm()`, `expectToast()` and `expectInputValue()` (for input values; Playwright has no `getByDisplayValue`).
- Find elements with `getByRole`, `getByLabel` (use `{ exact: true }` for short labels such as "Password") or `getByText`.
- Add `data-testid` only when none of those work. Leave a comment saying why.
- Never use CSS class names or DOM position as selectors.
- Never use `waitForTimeout` or fixed sleeps. Use web-first assertions such as `expect(locator).toBeVisible()`, which retry on their own.

**Test design**
- One behaviour per test, named for that behaviour: `test('a student cannot approve an order')`.
- Check what the server refuses with `apiAs('student')` and the like. Do not assume a hidden button is a permission check.
- Drive the UI for the flow under test. Use the API only for setup, or to check a result the UI cannot show.
- Do not assert on today's date or on wall-clock times.
- Use `page.route` only to stub third-party calls made by the browser. Never stub the app's own `/api` calls.
- The supplier search, product lookup and Onshape calls run on the server, so they are not covered yet. Do not write tests that hit the real supplier sites.

**Accessibility and layout**
- `accessibility.spec.js` runs axe (WCAG 2 A/AA) on each tab. A tab with a known axe problem is listed in `KNOWN` and its test is `test.fixme`. Remove the entry when the problem is fixed. Never add a rule exclusion to get a green run.
- `responsive.spec.js` checks that each tab fits a 390px-wide phone without sideways scrolling.

**Known bugs**
- Bugs listed in `bugs.md` must not be encoded as passing behaviour. Mark the test `test.fixme(true, 'see bugs.md: <title>')`.

**Files**
- Upload fixtures come only from `e2e/fixtures-files/`. Never upload real team photos or part files.
- Do not commit `e2e/.auth/`, `e2e/test-results/` or `e2e/playwright-report/`.
- Do not run `git add`, `git commit` or `git push` unless the user asks. The user handles commits.

**When a test fails**
- Work out whether the app, the test, or the environment is wrong before changing anything. Read the trace or screenshot in `e2e/test-results/`.
- Do not weaken an assertion to make a test pass. If the app is wrong, say so.
- Retries are for CI only. Locally, a flaky test is a bug to fix.
