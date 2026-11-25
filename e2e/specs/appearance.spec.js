import { test, expect } from '../support/fixtures.js';
import { openTab } from '../support/ui.js';

// The theme is set on <html> with data-theme. The check is the page's real background colour, not just the attribute.
async function backgroundColor(page) {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

test('choosing Dark and Light changes the page colours', async ({ studentPage }) => {
  await openTab(studentPage, 'Settings');

  await studentPage.getByRole('button', { name: /Light/ }).click();
  await expect(studentPage.locator('html')).toHaveAttribute('data-theme', 'light');
  const light = await backgroundColor(studentPage);

  await studentPage.getByRole('button', { name: /Dark/ }).click();
  await expect(studentPage.locator('html')).toHaveAttribute('data-theme', 'dark');
  const dark = await backgroundColor(studentPage);

  expect(dark).not.toBe(light);
});

test('Auto follows the computer: dark when it prefers dark, light when it prefers light', async ({ browser }) => {
  async function pageWithScheme(colorScheme) {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    return { context, page };
  }

  const dark = await pageWithScheme('dark');
  // No saved choice, so the page should not force a theme on <html>.
  await expect(dark.page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  const darkBackground = await backgroundColor(dark.page);
  await dark.context.close();

  const light = await pageWithScheme('light');
  await expect(light.page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  expect(await backgroundColor(light.page)).not.toBe(darkBackground);
  await light.context.close();
});
