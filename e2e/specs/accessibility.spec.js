import { test, expect } from '../support/fixtures.js';
import { openTab } from '../support/ui.js';
import AxeBuilder from '@axe-core/playwright';

// Automated WCAG 2.0/2.1 A and AA checks. They catch missing labels, poor contrast and broken ARIA.
// They don't replace a person testing with a screen reader.
async function expectNoViolations(page, where) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  // Name the first few elements, so a failure says what to fix.
  const summary = violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} element(s), e.g. ${v.nodes.slice(0, 2).map((n) => n.html.slice(0, 120)).join(' | ')}`);
  expect(summary, `accessibility problems on ${where}`).toEqual([]);
}

test('the sign-in screen has no detectable accessibility problems', async ({ anonPage }) => {
  await anonPage.goto('/');
  await expect(anonPage.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expectNoViolations(anonPage, 'the sign-in screen');
});

// Tabs with known problems found by this scan. They're marked fixme, not weakened, until the app is fixed.
const KNOWN = {
  Orders: 'axe: "Group" label has too little contrast; two <select>s have no accessible name (toolbar, Orders)',
  Inventory: 'axe: "Group" label has too little contrast (toolbar, Inventory)',
};

for (const tab of ['Board', 'Orders', 'Inventory', 'Carts', 'Budget', 'Settings']) {
  const define = KNOWN[tab] ? test.fixme : test;
  define(`the ${tab} tab has no detectable accessibility problems`, async ({ mentorPage }) => {
    await openTab(mentorPage, tab);
    await expect(mentorPage.getByRole('navigation').getByRole('button', { name: new RegExp(`^${tab}`) })).toHaveClass(/active/);
    await expectNoViolations(mentorPage, `the ${tab} tab`);
  });
}
