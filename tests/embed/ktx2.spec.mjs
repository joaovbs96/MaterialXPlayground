// tests/embed/ktx2.spec.mjs: bindDroppedTextures (js/mtlx-engine.js) must
// prefer a "<stem>.ktx2" sibling over its authored source, and the
// resulting THREE.KTX2Loader-decoded CompressedTexture must render with
// the SAME orientation as the plain PNG (both upload with flipY=false;
// scripts/cook-textures.mjs never flips at encode time either).
//
// Proof strategy: cook a self-authored 4-quadrant PNG into a .ktx2 sibling,
// then render the SAME viewer setup twice — once with only the PNG dropped,
// once with the PNG plus its .ktx2 sibling — and assert the rendered pixels
// are the same. Only the second run's console output should report the
// substitution.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const COOK_SCRIPT = path.join(REPO_ROOT, 'scripts', 'cook-textures.mjs');

// --- self-authored fixture: a 64x64 PNG, one flat color per quadrant ---
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
// Quadrants (top-left, top-right, bottom-left, bottom-right of the source
// image, row 0 = top): red, green, blue, yellow.
const QUADRANT_COLORS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
function quadrantColorFor(x, y, size) {
  const half = size / 2;
  const col = x < half ? 0 : 1;
  const row = y < half ? 0 : 1;
  return QUADRANT_COLORS[row * 2 + col];
}
function makeQuadrantPng(size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = quadrantColorFor(x, y, size);
      const o = y * (1 + size * 4) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

const QUAD_MTLX = `<?xml version="1.0"?>
<materialx version="1.39" colorspace="lin_rec709">
  <image name="img_quad" type="color3">
    <input name="file" type="filename" value="quad.png" />
  </image>
  <surface_unlit name="SR_Quad" type="surfaceshader">
    <input name="emission_color" type="color3" nodename="img_quad" />
  </surface_unlit>
  <surfacematerial name="Quad" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="SR_Quad" />
  </surfacematerial>
</materialx>
`;

let workDir;
test.beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtlx-ktx2-spec-'));
  const pngBuf = makeQuadrantPng(64);
  const pngOnlyDir = path.join(workDir, 'png-only');
  const withKtx2Dir = path.join(workDir, 'with-ktx2');
  fs.mkdirSync(pngOnlyDir, { recursive: true });
  fs.mkdirSync(withKtx2Dir, { recursive: true });
  fs.writeFileSync(path.join(pngOnlyDir, 'quad.mtlx'), QUAD_MTLX);
  fs.writeFileSync(path.join(pngOnlyDir, 'quad.png'), pngBuf);
  fs.writeFileSync(path.join(withKtx2Dir, 'quad.mtlx'), QUAD_MTLX);
  fs.writeFileSync(path.join(withKtx2Dir, 'quad.png'), pngBuf);
  execFileSync(process.execPath, [COOK_SCRIPT, withKtx2Dir, '--jobs', '1'], { stdio: 'pipe', timeout: 120000 });
  expect(fs.existsSync(path.join(withKtx2Dir, 'quad.ktx2'))).toBe(true);
});
test.afterAll(() => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* best-effort */ } });

async function loadDirAndScreenshot(page, embedURL, dir) {
  await page.goto(embedURL + '/index.html#!viewer');
  const dirInput = page.locator('input[type=file][webkitdirectory]').first();
  await dirInput.waitFor({ state: 'attached', timeout: WAIT_TIMEOUT });
  const consoleLines = [];
  const onConsole = (m) => consoleLines.push(m.text());
  page.on('console', onConsole);
  await dirInput.setInputFiles(dir);
  await expect(page.getByText('1 .mtlx', { exact: false })).toBeVisible({ timeout: WAIT_TIMEOUT });
  await page.waitForTimeout(1200); // texture bind is async; let it settle
  const canvas = page.locator('canvas').first();
  const png = decodePNG(await canvas.screenshot());
  page.off('console', onConsole); // page.on persists across page.goto; a later run must not leak into this one's array
  return { png, consoleLines };
}

function quadrantMeanColors(png) {
  const halfW = Math.floor(png.width / 2), halfH = Math.floor(png.height / 2);
  const sums = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  // Sample well inside each quadrant, away from the model's silhouette edge.
  const margin = Math.floor(Math.min(halfW, halfH) * 0.3);
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      const x0 = col * halfW + margin, x1 = (col + 1) * halfW - margin;
      const y0 = row * halfH + margin, y1 = (row + 1) * halfH - margin;
      const idx = row * 2 + col;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = png.getPixel(x, y);
          sums[idx][0] += p.r; sums[idx][1] += p.g; sums[idx][2] += p.b; sums[idx][3] += 1;
        }
      }
    }
  }
  return sums.map(([r, g, b, n]) => (n ? [r / n, g / n, b / n] : [0, 0, 0]));
}

test('@ktx2 a .ktx2 sibling renders with the same orientation as its source PNG', async ({ page, embedURL }) => {
  const pngOnlyDir = path.join(workDir, 'png-only');
  const withKtx2Dir = path.join(workDir, 'with-ktx2');

  const runA = await loadDirAndScreenshot(page, embedURL, pngOnlyDir);
  const runB = await loadDirAndScreenshot(page, embedURL, withKtx2Dir);

  const quadA = quadrantMeanColors(runA.png);
  const quadB = quadrantMeanColors(runB.png);

  // Same geometry/camera/material both runs: only the bound texture format
  // differs. Any orientation mismatch (a baked-in flip going the wrong way)
  // would swap top/bottom or left/right quadrants between the two runs.
  for (let i = 0; i < 4; i++) {
    const [ar, ag, ab] = quadA[i];
    const [br, bg, bb] = quadB[i];
    const dist = Math.sqrt((ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2);
    expect(dist, `quadrant ${i} color drifted between the PNG-only and KTX2 runs`).toBeLessThan(40);
  }

  // Only the second run (folder + sibling) should report a substitution.
  expect(runA.consoleLines.some((l) => /loaded from \.ktx2 sibling/i.test(l))).toBe(false);
  expect(runB.consoleLines.some((l) => /loaded from \.ktx2 sibling/i.test(l))).toBe(true);
});

// --- invalid base level fixture: a hand-built 10x10 UASTC .ktx2 whose base
// level is not a multiple of 4 (WebGL rejects it, sampling solid black),
// plus its 10x10 orange PNG source. Built once with:
//   toktx --t2 --encode uastc --uastc_quality 2 --genmipmap --zcmp 18 \
//     --assign_oetf srgb ktx2-badbase-10x10.ktx2 ktx2-badbase-10x10.png
// ktxinfo confirms pixelWidth/pixelHeight are 10 (not a multiple of 4).
const BADBASE_MTLX = `<?xml version="1.0"?>
<materialx version="1.39" colorspace="lin_rec709">
  <image name="img_bad" type="color3">
    <input name="file" type="filename" value="badbase.png" />
  </image>
  <surface_unlit name="SR_Bad" type="surfaceshader">
    <input name="emission_color" type="color3" nodename="img_bad" />
  </surface_unlit>
  <surfacematerial name="Bad" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="SR_Bad" />
  </surfacematerial>
</materialx>
`;

test('@ktx2 an invalid (non-multiple-of-4) .ktx2 base level falls back to the source', async ({ page, embedURL }) => {
  const referenceDir = path.join(workDir, 'badbase-reference'); // PNG only, no .ktx2 sibling at all
  const badbaseDir = path.join(workDir, 'badbase'); // PNG plus its invalid .ktx2 sibling
  fs.mkdirSync(referenceDir, { recursive: true });
  fs.mkdirSync(badbaseDir, { recursive: true });
  fs.writeFileSync(path.join(referenceDir, 'badbase.mtlx'), BADBASE_MTLX);
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'ktx2-badbase-10x10.png'), path.join(referenceDir, 'badbase.png'));
  fs.writeFileSync(path.join(badbaseDir, 'badbase.mtlx'), BADBASE_MTLX);
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'ktx2-badbase-10x10.png'), path.join(badbaseDir, 'badbase.png'));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'ktx2-badbase-10x10.ktx2'), path.join(badbaseDir, 'badbase.ktx2'));

  await page.addInitScript(() => { try { localStorage.setItem('mtlxDebugShaders', '1'); } catch (e) {} });
  const reference = await loadDirAndScreenshot(page, embedURL, referenceDir);
  const run = await loadDirAndScreenshot(page, embedURL, badbaseDir);

  // The whole model is one flat color; sample its center in both runs.
  const cx = Math.floor(run.png.width / 2), cy = Math.floor(run.png.height / 2);
  const refPixel = reference.png.getPixel(cx, cy);
  const p = run.png.getPixel(cx, cy);

  // A black (invalid-KTX2) render would sample near (0,0,0); the reference
  // (PNG-only, never touches the bad .ktx2) proves what the orange source
  // renders as under this pipeline's color management, so compare against
  // it rather than an assumed absolute RGB.
  expect(refPixel.r, 'sanity: the reference render should not itself be black').toBeGreaterThan(30);
  const dist = Math.sqrt((p.r - refPixel.r) ** 2 + (p.g - refPixel.g) ** 2 + (p.b - refPixel.b) ** 2);
  expect(dist, 'the invalid-.ktx2 run should fall back and match the PNG-only reference').toBeLessThan(40);

  expect(run.consoleLines.some((l) => /not a multiple of 4/i.test(l))).toBe(true);
});
