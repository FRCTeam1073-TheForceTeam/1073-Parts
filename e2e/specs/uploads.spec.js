import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, uniq } from '../support/fixtures.js';
import { openTab, expectToast } from '../support/ui.js';

const FIXTURES = fileURLToPath(new URL('../fixtures-files/', import.meta.url));

test('a mentor attaches a photo to a custom part and it is saved', async ({ mentorPage, apiAs }) => {
  const name = uniq('E2E Photo Part');

  await openTab(mentorPage, 'Board');
  await mentorPage.getByRole('button', { name: '+ Custom part', exact: true }).click();
  await mentorPage.getByLabel('Part name', { exact: true }).fill(name);

  // "Upload file" opens the system file picker. Catch it and give it the fixture picture.
  const chooser = mentorPage.waitForEvent('filechooser');
  await mentorPage.getByRole('button', { name: 'Upload file', exact: true }).click();
  (await chooser).setFiles(path.join(FIXTURES, 'part.png'));

  // Once the picture is saved, the button offers "Upload another" and a "Remove" button appears.
  await expect(mentorPage.getByRole('button', { name: 'Upload another', exact: true })).toBeVisible();
  await expect(mentorPage.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();

  await mentorPage.getByRole('button', { name: 'Add part', exact: true }).click();
  await expectToast(mentorPage, 'Custom part added');

  const parts = await (await apiAs('mentor')).get('/api/custom-parts');
  const saved = (await parts.json()).find((p) => p.name === name);
  expect(saved?.image).toMatch(/^\/api\/uploads\//);
});

test('a file that is not a picture is refused with a clear message', async ({ mentorPage }) => {
  await openTab(mentorPage, 'Board');
  await mentorPage.getByRole('button', { name: '+ Custom part', exact: true }).click();

  const chooser = mentorPage.waitForEvent('filechooser');
  await mentorPage.getByRole('button', { name: 'Upload file', exact: true }).click();
  (await chooser).setFiles(path.join(FIXTURES, 'not-an-image.txt'));

  await expectToast(mentorPage, 'That file is not an image.');
  await expect(mentorPage.getByRole('button', { name: 'Upload another', exact: true })).toHaveCount(0);
});
