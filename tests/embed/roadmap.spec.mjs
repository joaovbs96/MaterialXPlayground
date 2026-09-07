// tests/embed/roadmap.spec.mjs: the Roadmap view fetches and parses
// ROADMAP.md at view time. Counts items straight from the file on disk
// so the spec stays correct as the roadmap changes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const roadmapText = fs.readFileSync(path.join(REPO_ROOT, 'ROADMAP.md'), 'utf8');
const itemCount = (roadmapText.match(/^- \[/gm) || []).length;
const parkedCount = (roadmapText.match(/^- \[parked\]/gm) || []).length;

test('@smoke Roadmap fetches ROADMAP.md and renders it as the site design', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!roadmap');

  await expect(page.getByRole('heading', { name: 'Roadmap', level: 1 })).toBeVisible();
  await expect(page.getByText('KTX2 compressed textures')).toBeVisible();

  const rows = page.locator('.font-semibold.text-gray-100.text-sm');
  await expect(rows).toHaveCount(itemCount);

  await page.getByRole('button', { name: /^Parked/ }).click();
  await expect(rows).toHaveCount(parkedCount);

  await expect(page.getByText('Edit ROADMAP.md in the repository to change this page.')).toBeVisible();
});
