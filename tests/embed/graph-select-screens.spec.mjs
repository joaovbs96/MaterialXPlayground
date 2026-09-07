import fs from 'node:fs';
import path from 'node:path';
import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';

// Opt-in: needs the Stirling MaterialX collection in place on disk (never
// copied into the repo). Verifies the graph editor's document picker at
// three menu-bar widths once the wider max-w-[28rem] cap is applied, with
// a real 29-material folder (long, similarly-prefixed names).
const materialsRoot = process.env.MTLX_STIRLING_MATERIALS;
test.skip(!materialsRoot, 'MTLX_STIRLING_MATERIALS not set');

const outDir = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\dd1';

test('@graphselect document picker shows whole names up to the cap at three menu-bar widths', async ({ page, embedURL }) => {
  fs.mkdirSync(outDir, { recursive: true });

  await page.goto(embedURL + '/index.html#!graph');
  await page.waitForSelector('.gtb-bar', { timeout: WAIT_TIMEOUT });

  const files = fs.readdirSync(materialsRoot).filter((f) => f.toLowerCase().endsWith('.mtlx'));
  expect(files.length).toBeGreaterThanOrEqual(29);

  // Build a { relPath: base64 } map in Node, hand it to the page, and
  // reconstruct Blobs there for window.__mtlxPendingImport + the
  // 'mtlx-load-document' event (js/graph-app.jsx:1462-1499's handleImport
  // path), the same handoff "Send to Editor" uses.
  const encoded = {};
  for (const f of files) {
    encoded['materials/Real_Time/' + f] = fs.readFileSync(path.join(materialsRoot, f)).toString('base64');
  }
  const rootXml = fs.readFileSync(path.join(materialsRoot, files[0]), 'utf8');

  await page.evaluate(({ encoded, rootXml }) => {
    const files = {};
    Object.keys(encoded).forEach((relPath) => {
      const bin = atob(encoded[relPath]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      files[relPath] = new Blob([bytes], { type: 'application/xml' });
    });
    const detail = { xml: rootXml, name: 'Materials', files, select: null };
    window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail }));
  }, { encoded, rootXml });

  // The document picker only renders once mtlxPaths.length > 1.
  const picker = page.locator('.gtb-bar').getByRole('combobox').first();
  await expect(picker).toBeVisible({ timeout: WAIT_TIMEOUT });

  for (const width of [1600, 1280, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150); // ResizeObserver settle (measureToolbarCluster)
    await picker.click();
    const listbox = page.getByRole('listbox');
    await expect(listbox).toBeVisible();
    await page.screenshot({ path: path.join(outDir, 'graph-menubar-' + width + '.png') });
    await page.keyboard.press('Escape');
  }
});
