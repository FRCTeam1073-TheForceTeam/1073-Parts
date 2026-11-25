// Playwright fixtures. Each role page gets its own browser context loaded with that role's saved login,
// so tests never share cookies. anonPage starts signed out. apiAs(role) gives an API client logged in as a role.
import { test as base, expect } from '@playwright/test';
import { authPath } from './accounts.js';

export { uniq } from './api.js';

async function pageFor(browser, storageState) {
  const context = await browser.newContext(storageState ? { storageState } : {});
  const page = await context.newPage();
  return { context, page };
}

export const test = base.extend({
  anonPage: async ({ browser }, use) => {
    const { context, page } = await pageFor(browser, null);
    await use(page);
    await context.close();
  },
  adminPage: async ({ browser }, use) => {
    const { context, page } = await pageFor(browser, authPath('admin'));
    await use(page);
    await context.close();
  },
  mentorPage: async ({ browser }, use) => {
    const { context, page } = await pageFor(browser, authPath('mentor'));
    await use(page);
    await context.close();
  },
  studentPage: async ({ browser }, use) => {
    const { context, page } = await pageFor(browser, authPath('student'));
    await use(page);
    await context.close();
  },
  // apiAs('student') or apiAs(null) for signed out. Use it to check what the server refuses.
  apiAs: async ({ playwright, baseURL }, use) => {
    const contexts = [];
    await use(async (role) => {
      const ctx = await playwright.request.newContext({ baseURL, ...(role ? { storageState: authPath(role) } : {}) });
      contexts.push(ctx);
      return ctx;
    });
    for (const ctx of contexts) await ctx.dispose();
  },
});

export { expect };
