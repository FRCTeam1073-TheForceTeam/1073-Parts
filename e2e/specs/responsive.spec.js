import { test, expect } from '../support/fixtures.js';
import { openTab } from '../support/ui.js';

// A phone-width screen. The page must not scroll sideways, or the content is cut off.
test.use({ viewport: { width: 390, height: 844 } });

async function expectNoSidewaysScroll(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'page is wider than the screen').toBeLessThanOrEqual(0);
}

test('the sign-in screen fits a phone', async ({ anonPage }) => {
  await anonPage.goto('/');
  await expect(anonPage.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expectNoSidewaysScroll(anonPage);
});

for (const tab of ['Board', 'Orders', 'Inventory', 'Carts', 'Budget', 'Settings']) {
  test(`the ${tab} tab fits a phone`, async ({ mentorPage }) => {
    await openTab(mentorPage, tab);
    await expect(mentorPage.getByRole('navigation').getByRole('button', { name: new RegExp(`^${tab}`) })).toHaveClass(/active/);
    await expectNoSidewaysScroll(mentorPage);
  });
}
