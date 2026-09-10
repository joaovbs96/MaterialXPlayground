// tests/embed/usd-scene-overrides.spec.mjs: USD `over` blocks on a
// referenced MaterialX material (usd-stage-worker.js collectMaterialOverrides,
// js/usd-scene-renderer.js applyUsdOverrides) must be applied onto the
// resolved document before generation: an unconnected scalar override wins
// over the file's own value, an asset override swaps the bound texture, an override
// on a node named only in the .mtlx (never a `def` in any usda) is found
// and applied via the document-text scan, and an override naming a node
// that does not exist anywhere produces exactly one warning.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-scene');
function fixtureFile(relativePath) {
  return { name: relativePath, mimeType: 'text/plain', buffer: fs.readFileSync(path.join(fixtureRoot, relativePath)) };
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function makeSolidPng(size, [r, g, b]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * (1 + size * 4) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

function meanOfRegion(png, x0, x1, y0, y1, bg) {
  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = png.getPixel(x, y);
    if (Math.abs(p.r - bg.r) + Math.abs(p.g - bg.g) + Math.abs(p.b - bg.b) <= 10) continue;
    sumR += p.r; sumG += p.g; sumB += p.b; count++;
  }
  return count ? { r: sumR / count, g: sumG / count, b: sumB / count } : null;
}

test('@scene USD overrides on a referenced MaterialX material apply a scalar override, swap a texture, and warn on a missing node', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();

  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    fixtureFile('override-root.usda'),
    fixtureFile('override.mtlx'),
    { name: 'tex-a.png', mimeType: 'image/png', buffer: makeSolidPng(4, [0, 255, 0]) },
    { name: 'tex-b.png', mimeType: 'image/png', buffer: makeSolidPng(4, [255, 255, 0]) },
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-scene-error')).toHaveCount(0);

  const warningsText = (await page.getByTestId('usd-material-warnings').allTextContents()).join('\n');
  expect(warningsText).toContain('USD override targets missing MaterialX node "mtlxplace2d1"');

  const sidebar = page.getByTestId('usd-scene-sidebar');
  const backdrop = sidebar.getByRole('combobox').last();
  await backdrop.click();
  await page.getByRole('option', { name: 'None', exact: true }).click();
  await page.waitForTimeout(150);

  const canvas = page.getByTestId('usd-scene-canvas').locator('canvas');
  const png = decodePNG(await canvas.screenshot());
  const bg = png.getPixel(0, 0);
  const third = Math.floor(png.width / 3);

  const leftMean = meanOfRegion(png, 0, third, 0, png.height, bg);
  const midMean = meanOfRegion(png, third, third * 2, 0, png.height, bg);
  const rightMean = meanOfRegion(png, third * 2, png.width, 0, png.height, bg);
  expect(leftMean).toBeTruthy();
  expect(midMean).toBeTruthy();
  expect(rightMean).toBeTruthy();

  // Left quad: the file's blue literal is overridden to red.
  expect(leftMean.r).toBeGreaterThan(150);
  expect(leftMean.g).toBeLessThan(60);
  expect(leftMean.b).toBeLessThan(60);

  // Middle quad: the file's tex-a.png (green) is swapped for tex-b.png (yellow).
  expect(midMean.r).toBeGreaterThan(150);
  expect(midMean.g).toBeGreaterThan(150);
  expect(midMean.b).toBeLessThan(60);

  // Right quad: "const_doc_only" has no `def` anywhere, only the `over`
  // below and a matching node in override.mtlx -- found via the document
  // text scan, not the usda scene graph -- overriding its value from the
  // file's green to yellow.
  expect(rightMean.r).toBeGreaterThan(150);
  expect(rightMean.g).toBeGreaterThan(150);
  expect(rightMean.b).toBeLessThan(60);
});
