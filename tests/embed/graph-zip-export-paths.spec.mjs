import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';

// Covers the ZIP export path bug: a texture referenced as '../textures/x.png'
// used to be written to the zip as-is minus a leading './' or '/' (doExportZip,
// js/graph-app.jsx), so unzip tools that strip '..' entries lost the texture
// and the unzipped .mtlx no longer resolved it. js/graph/zip-export-paths.js
// now relocates any escaping ref under textures/ and rewrites the document's
// filename input to match.

const ESCAPING_TEXTURE_MTLX = [
  '<?xml version="1.0"?>',
  '<materialx version="1.39">',
  '  <standard_surface name="surf" type="surfaceshader" />',
  '  <image name="img" type="color3">',
  '    <input name="file" type="filename" value="../textures/x.png" />',
  '  </image>',
  '  <surfacematerial name="mat" type="material">',
  '    <input name="surfaceshader" type="surfaceshader" nodename="surf" />',
  '  </surfacematerial>',
  '</materialx>',
].join('\n');

const openGraphEditor = async (page, embedURL) => {
  await page.goto(embedURL + '/index.html#!graph');
  await page.waitForSelector('.gtb-bar', { timeout: WAIT_TIMEOUT });
  await page.waitForFunction(() => typeof window.parseMtlxDocument === 'function'
    && typeof window.serializeDocXml === 'function', null, { timeout: WAIT_TIMEOUT });
};

test('ZIP export relocates a texture ref that escapes the zip root, no ".." entries', async ({ page, embedURL }) => {
  await openGraphEditor(page, embedURL);

  // Captures the exported blob instead of driving a real download, and
  // unpacks it in-page (window.JSZip is already loaded there).
  await page.evaluate(() => {
    window.__zipExportResult = new Promise((resolve) => {
      window.downloadBlob = async (blob, filename) => {
        const zip = await window.JSZip.loadAsync(blob);
        const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
        const mtlxName = names.find((n) => n.endsWith('.mtlx'));
        const mtlxText = await zip.files[mtlxName].async('text');
        resolve({ filename, names, mtlxText });
      };
    });
  });

  // The doc references '../textures/x.png'; the dropped file is keyed by
  // its basename alone, matched via findFilesForRef's basename fallback.
  await page.evaluate((xml) => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const files = { 'x.png': new Blob([bytes], { type: 'image/png' }) };
    window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: { xml, name: 'ziptest', files } }));
  }, ESCAPING_TEXTURE_MTLX);
  await expect.poll(async () => page.evaluate(async () => {
    try { return await window.__mtlxGetGraphXml(); } catch (e) { return ''; }
  }), { timeout: WAIT_TIMEOUT }).toContain('../textures/x.png');

  await page.getByRole('menubar').getByRole('menuitem', { name: 'File', exact: true }).click();
  await page.getByText('Export .mtlx…', { exact: true }).click();
  await page.getByText('ZIP with textures (.zip)', { exact: true }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();

  const result = await page.evaluate(() => window.__zipExportResult);

  expect(result.filename.endsWith('.zip')).toBe(true);
  for (const name of result.names) {
    expect(name.split('/'), 'zip entry escapes the root: ' + name).not.toContain('..');
  }
  expect(result.names).toContain('textures/x.png');
  expect(result.mtlxText).not.toContain('../textures/x.png');
  expect(result.mtlxText).toContain('textures/x.png');
});
