// tests/embed/usd-scene-ktx2.spec.mjs: the USD Scene's texture resolver
// (sceneExactFile, js/usd-scene-renderer.js) must prefer a "quad.ktx2"
// sibling over the authored "quad.png" it names, decode it as compressed
// GPU block data (js/mtlx-engine.js loadKtx2Texture), and count its real
// (smaller) byte footprint instead of the planner's RGBA8 estimate.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const COOK_SCRIPT = path.join(REPO_ROOT, 'scripts', 'cook-textures.mjs');
const fixtureRoot = path.resolve(__dirname, '..', 'fixtures', 'usd-scene');
function fixtureFile(relativePath, buffer) {
  return { name: relativePath, mimeType: 'text/plain', buffer: buffer || fs.readFileSync(path.join(fixtureRoot, relativePath)) };
}

const QUAD_RGB = [80, 160, 220];

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

function meanOfRegion(png, x0, x1, y0, y1) {
  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = png.getPixel(x, y);
    sumR += p.r; sumG += p.g; sumB += p.b; count++;
  }
  return count ? { r: sumR / count, g: sumG / count, b: sumB / count } : null;
}

let cookedDir;
test.beforeAll(() => {
  cookedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtlx-scene-ktx2-spec-'));
  fs.writeFileSync(path.join(cookedDir, 'quad.png'), makeSolidPng(256, QUAD_RGB));
  execFileSync(process.execPath, [COOK_SCRIPT, cookedDir, '--jobs', '1'], { stdio: 'pipe', timeout: 120000 });
  expect(fs.existsSync(path.join(cookedDir, 'quad.ktx2'))).toBe(true);
});
test.afterAll(() => { try { fs.rmSync(cookedDir, { recursive: true, force: true }); } catch (e) { /* best-effort */ } });

test('@scene a .ktx2 sibling in the upload replaces the PNG and counts compressed bytes', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();

  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(m.text()));

  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    fixtureFile('texture-formats-ktx2-root.usda'),
    fixtureFile('texture-formats-ktx2.mtlx'),
    fixtureFile('quad.png', fs.readFileSync(path.join(cookedDir, 'quad.png'))),
    fixtureFile('quad.ktx2', fs.readFileSync(path.join(cookedDir, 'quad.ktx2'))),
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-scene-error')).toHaveCount(0);

  // The quad fills the frame: sample its center directly against the
  // authored PNG's color (compressed-transcode is lossy, so a tolerance).
  const sidebar = page.getByTestId('usd-scene-sidebar');
  const backdrop = sidebar.getByRole('combobox').last();
  await backdrop.click();
  await page.getByRole('option', { name: 'None', exact: true }).click();
  await page.waitForTimeout(150);

  const canvas = page.getByTestId('usd-scene-canvas').locator('canvas');
  const png = decodePNG(await canvas.screenshot());
  const center = meanOfRegion(png, Math.floor(png.width * 0.4), Math.floor(png.width * 0.6), Math.floor(png.height * 0.4), Math.floor(png.height * 0.6));
  expect(center).toBeTruthy();
  expect(Math.abs(center.r - QUAD_RGB[0])).toBeLessThan(30);
  expect(Math.abs(center.g - QUAD_RGB[1])).toBeLessThan(30);
  expect(Math.abs(center.b - QUAD_RGB[2])).toBeLessThan(30);

  // The planner counted compressed KTX2 bytes (~1 byte/pixel *4/3), far
  // below the RGBA8 estimate (4 bytes/pixel *4/3) for the same 256x256.
  const stats = await page.evaluate(() => window.__mtlxUsdSceneHandle.getTextureStats());
  const rgba8Estimate = 256 * 256 * 4 * (4 / 3);
  expect(stats.fullBytes).toBeLessThan(rgba8Estimate);
  expect(stats.ktx2Substituted).toBeGreaterThan(0);

  // Diagnostics notice: N texture(s) loaded from KTX2 sibling(s).
  const warningsText = (await page.getByTestId('usd-material-warnings').allTextContents()).join('\n');
  expect(warningsText).toMatch(/loaded from KTX2 sibling/i);
});
