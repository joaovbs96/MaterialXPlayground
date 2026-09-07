// Opt-in headed cross-check: does the Viewer render the Scene worker's
// cage (sub0) and Loop-subdivided (sub1) Rook meshes differently, and is
// the normal map actually bound in every leg? Loads three known OBJs
// (product sub0, product sub1, a prototype Loop level 1) into the
// Material Viewer under the real Rook material, and runs the same
// subdivision-1 check inside the Scene. Not part of any CI tier; set
// USD_CHESS_ROOT to run.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const chessRoot = process.env.USD_CHESS_ROOT || '';
const rookRoot = chessRoot ? path.join(path.dirname(chessRoot), 'assets', 'Rook') : '';
const OUT_DIR = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\ab15';
fs.mkdirSync(OUT_DIR, { recursive: true });
const VIEWPORT = { width: 1400, height: 1100 };

const OBJ_SUB0 = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\ab14\\rook-product-sub0.obj';
const OBJ_SUB1 = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\ab14\\rook-product-sub1.obj';
const OBJ_LOOP1 = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\ab7\\rook-loop1.obj';

// --- minimal 8-bit RGBA PNG writer (filter type 0, matches png.mjs's decoder) ---
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(crcBuf) : crc32(crcBuf), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
// CRC32 fallback for older Node without zlib.crc32.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function cropTo2x(image, x0, y0, w, h, outPath) {
  const scale = 2;
  const outW = w * scale, outH = h * scale;
  const rgba = Buffer.alloc(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(image.width - 1, x0 + Math.floor(x / scale));
      const sy = Math.min(image.height - 1, y0 + Math.floor(y / scale));
      const p = image.getPixel(sx, sy);
      const o = (y * outW + x) * 4;
      rgba[o] = p.r; rgba[o + 1] = p.g; rgba[o + 2] = p.b; rgba[o + 3] = p.a;
    }
  }
  fs.writeFileSync(outPath, encodePNG(outW, outH, rgba));
}

// Finds the lower gold band's vertical position: scans rows for the
// gold-ish band closest to the bottom quarter of the image (high R+G,
// low B, distinct from the neutral backdrop/base color).
function findLowerGoldBandRow(image) {
  const isGold = (p) => p.r > 120 && p.g > 90 && p.b < 110 && (p.r - p.b) > 40 && (p.g - p.b) > 15;
  const rowsWithGold = [];
  for (let y = 0; y < image.height; y++) {
    let count = 0;
    for (let x = 0; x < image.width; x++) if (isGold(image.getPixel(x, y))) count++;
    if (count > image.width * 0.05) rowsWithGold.push(y);
  }
  if (!rowsWithGold.length) return Math.floor(image.height * 0.65);
  return rowsWithGold[rowsWithGold.length - 1];
}

// --- in-page: for the surface material of the given mesh/material pair,
// report sampler-default flags + sizes, geometry stats, and tangent frame
// samples. Runs identically in the Viewer and the Scene. ---
function collectDebugInfo(materials, sceneObj) {
  /* eslint-disable no-undef */
  const results = [];
  for (const mat of materials) {
    if (!mat) { results.push({ samplers: [], geomInfo: null }); continue; }
    let mesh = null;
    sceneObj.traverse((obj) => { if (!mesh && obj.isMesh && obj.material === mat) mesh = obj; });
    const samplers = [];
    if (mat.uniforms) {
      for (const name of Object.keys(mat.uniforms)) {
        if (!/file|map|tex/i.test(name)) continue;
        const v = mat.uniforms[name].value;
        if (v && v.isTexture) {
          samplers.push({
            name,
            isDefault: window.samplerHoldsDefault ? window.samplerHoldsDefault({ value: v }) : null,
            width: v.image ? v.image.width || null : null,
            height: v.image ? v.image.height || null : null,
          });
        }
      }
    }
    let geomInfo = null;
    if (mesh && mesh.geometry) {
      const geo = mesh.geometry;
      const tangent = geo.attributes.i_tangent;
      const bitangent = geo.attributes.i_bitangent;
      const sample = (attr) => attr ? [0, 1, 2].map((i) => [attr.getX(i), attr.getY(i), attr.getZ(i)]) : null;
      geomInfo = {
        vertexCount: geo.attributes.position ? geo.attributes.position.count : null,
        hasIndex: !!geo.index,
        tangentSamples: sample(tangent),
        bitangentSamples: sample(bitangent),
      };
    }
    const fs_ = mat.userData && mat.userData.mtlxSceneCompiled ? mat.userData.mtlxSceneCompiled.fs : (mat.fragmentShader || '');
    results.push({ samplers, geomInfo, fragmentContainsRookBlack: fs_.includes('NG_RookBlack') });
  }
  return results;
  /* eslint-enable no-undef */
}

async function loadViewerMaterialAndGeometry(page, embedURL, objPath) {
  await page.goto(embedURL + '/index.html#!viewer');
  await page.waitForFunction(() => !document.body.innerText.includes('Generating shader'), { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);

  await page.locator('input[type=file][webkitdirectory]').first().setInputFiles(rookRoot);
  await page.waitForFunction(() => !document.body.innerText.includes('Generating shader'), { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => !!window.__mtlxViewerHandle, { timeout: 20000 }).catch(() => {});

  await page.locator('input[type=file][accept*=".obj"]').first().setInputFiles(objPath);
  await page.waitForFunction(() => {
    const h = window.__mtlxViewerHandle;
    if (!h || typeof h.__debug !== 'function') return false;
    const dbg = h.__debug();
    let found = false;
    dbg.scene.traverse((obj) => { if (!found && obj.isMesh && obj.material === dbg.material) found = true; });
    return found;
  }, {}, { timeout: 30000 }).catch(() => {});

  await page.waitForFunction(() => {
    const h = window.__mtlxViewerHandle;
    if (!h || typeof h.__debug !== 'function' || !window.samplerHoldsDefault) return true;
    const dbg = h.__debug();
    const mat = dbg.material;
    if (!mat || !mat.uniforms) return true;
    for (const name of Object.keys(mat.uniforms)) {
      if (!/file|map|tex/i.test(name)) continue;
      const v = mat.uniforms[name].value;
      if (v && v.isTexture && window.samplerHoldsDefault({ value: v })) return false;
    }
    return true;
  }, {}, { timeout: 30000 }).catch(() => {});

  await page.evaluate(() => { if (window.setDisplayTransform) window.setDisplayTransform('srgb'); });
  await page.evaluate(() => { if (window.__setBackdropModeForTest) window.__setBackdropModeForTest('studio'); });
  try {
    const backdropRow = page.locator('text=Backdrop').locator('..').getByRole('combobox');
    if (await backdropRow.count()) {
      await backdropRow.first().click();
      const opt = page.getByRole('option', { name: 'Studio', exact: true });
      if (await opt.count()) await opt.click();
    }
  } catch (e) { /* backdrop selector interaction skipped */ }
  await page.waitForTimeout(700);

  const debugInfo = await page.evaluate(({ collectFn }) => {
    // eslint-disable-next-line no-eval
    const collect = eval('(' + collectFn + ')');
    const h = window.__mtlxViewerHandle;
    const dbg = h.__debug();
    return collect([dbg.material], dbg.scene);
  }, { collectFn: collectDebugInfo.toString() });

  return debugInfo[0];
}

test.describe('@scene Rook cross-check: sub0 vs sub1 vs prototype Loop1 (opt-in)', () => {
  test.skip(!chessRoot, 'Set USD_CHESS_ROOT to run this diagnostic.');
  test.setTimeout(900000);

  const results = {};

  test('X0. Viewer: product sub0 (cage)', async ({ page, embedURL }) => {
    await page.setViewportSize(VIEWPORT);
    const debugInfo = await loadViewerMaterialAndGeometry(page, embedURL, OBJ_SUB0);
    await page.locator('canvas').first().screenshot({ path: path.join(OUT_DIR, 'X0-rook-product-sub0.png') });
    results.X0 = debugInfo;
  });

  test('X1. Viewer: product sub1 (Scene Loop1 output)', async ({ page, embedURL }) => {
    await page.setViewportSize(VIEWPORT);
    const debugInfo = await loadViewerMaterialAndGeometry(page, embedURL, OBJ_SUB1);
    await page.locator('canvas').first().screenshot({ path: path.join(OUT_DIR, 'X1-rook-product-sub1.png') });
    results.X1 = debugInfo;
  });

  test('X2. Viewer: prototype Loop1', async ({ page, embedURL }) => {
    await page.setViewportSize(VIEWPORT);
    const debugInfo = await loadViewerMaterialAndGeometry(page, embedURL, OBJ_LOOP1);
    await page.locator('canvas').first().screenshot({ path: path.join(OUT_DIR, 'X2-rook-loop1.png') });
    results.X2 = debugInfo;
  });

  test('X3. Scene: Rook alone at subdivision 1', async ({ page, embedURL }) => {
    await page.setViewportSize(VIEWPORT);
    await page.goto(embedURL + '/index.html#!scene');
    await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
    await page.locator('input[type=file][webkitdirectory]').setInputFiles(rookRoot);
    await expect(page.getByTestId('usd-scene-root-select')).toBeVisible({ timeout: 30000 });
    const rootCombobox = page.getByTestId('usd-scene-root-select').getByRole('combobox');
    if (await rootCombobox.count()) {
      await rootCombobox.click();
      const options = await page.getByRole('option').allTextContents();
      const selected = options.find((l) => l.endsWith('/Rook.usd') || l === 'Rook.usd');
      if (selected) await page.getByRole('option', { name: selected, exact: true }).click();
    }
    // subdivision level 1
    try {
      const subRow = page.locator('text=Subdivision').locator('..').getByRole('combobox');
      if (await subRow.count()) {
        await subRow.first().click();
        const opt1 = page.getByRole('option', { name: '1', exact: true });
        if (await opt1.count()) await opt1.click();
      }
    } catch (e) { /* subdivision selector interaction skipped */ }
    await page.getByTestId('usd-scene-sidebar').getByRole('button', { name: /^Load (?!example)/ }).click();
    await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 180000 });
    await page.waitForTimeout(800);

    const debugInfo = await page.evaluate(({ collectFn }) => {
      // eslint-disable-next-line no-eval
      const collect = eval('(' + collectFn + ')');
      const h = window.__mtlxUsdSceneHandle;
      const dbg = h.__debug();
      const collected = collect(dbg.materials, dbg.scene);
      const idx = collected.findIndex((r) => r.fragmentContainsRookBlack);
      return idx >= 0 ? collected[idx] : collected[0];
    }, { collectFn: collectDebugInfo.toString() });

    await page.getByTestId('usd-scene-canvas').screenshot({ path: path.join(OUT_DIR, 'X3-rook-scene-sub1.png') });
    results.X3 = debugInfo;
  });

  test.afterAll(() => {
    fs.writeFileSync(path.join(OUT_DIR, 'debug-results.json'), JSON.stringify(results, null, 2), 'utf8');

    const shots = {
      X0: 'X0-rook-product-sub0.png',
      X1: 'X1-rook-product-sub1.png',
      X2: 'X2-rook-loop1.png',
      X3: 'X3-rook-scene-sub1.png',
    };
    for (const [key, name] of Object.entries(shots)) {
      const full = path.join(OUT_DIR, name);
      if (!fs.existsSync(full)) continue;
      const image = decodePNG(fs.readFileSync(full));
      const bandRow = findLowerGoldBandRow(image);
      const y0 = Math.max(0, bandRow - 240);
      const x0 = Math.max(0, Math.floor(image.width / 2) - 160);
      cropTo2x(image, x0, y0, 320, 240, path.join(OUT_DIR, 'crop-' + key + '.png'));
    }
  });
});
