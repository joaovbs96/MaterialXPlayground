import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';

// Self-authored: real.mtlx is multi-material.mtlx's content, plus three
// macOS side-file entries a zip/folder export drops alongside real files.
const sideFilesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'side-files-dir');

// @sidefiles: none of the three side entries are documents, and picking
// one up used to throw in parseMtlxDocument. The filter (isHiddenSideFile,
// js/mtlx-engine.js) is shared by the graph, viewer, compare and USD
// scene loaders; this exercises it through the viewer's folder input.
test('@sidefiles a folder pick skips AppleDouble and Finder metadata entries', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!viewer');
  const dirInput = page.locator('input[type=file][webkitdirectory]').first();
  await dirInput.waitFor({ state: 'attached', timeout: WAIT_TIMEOUT });

  await dirInput.setInputFiles(sideFilesDir);

  // The real document parsed and rendered: its "N .mtlx" count reads 1
  // (the three side files never reached the file map), and no red error
  // banner appeared (a side file reaching parseMtlxDocument throws).
  await expect(page.getByText('1 .mtlx', { exact: false })).toBeVisible({ timeout: WAIT_TIMEOUT });
  await expect(page.locator('.bg-red-950\\/90')).toHaveCount(0);
  await expect(page.locator('.bg-red-950\\/40')).toHaveCount(0);
  // With exactly one surviving .mtlx, the multi-document picker (which
  // only renders once mtlxPaths.length > 1) never appears.
  await expect(page.getByText('Pick a document')).toHaveCount(0);
});
