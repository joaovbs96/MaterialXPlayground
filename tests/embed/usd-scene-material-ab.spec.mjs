import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const chessRoot = process.env.USD_CHESS_ROOT || '';
const stirlingRoot = process.env.USD_STIRLING_ROOT || '';
const AB_DIR = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\ab';
fs.mkdirSync(AB_DIR, { recursive: true });

// Central 40% box stats: mean luminance, p95, fraction of pixels above 230.
function boxStats(image) {
  const x0 = Math.floor(image.width * 0.3), x1 = Math.floor(image.width * 0.7);
  const y0 = Math.floor(image.height * 0.3), y1 = Math.floor(image.height * 0.7);
  const lums = [];
  let bright = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = image.getPixel(x, y);
    const l = 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;
    lums.push(l);
    if (l > 230) bright++;
  }
  lums.sort((a, b) => a - b);
  const mean = lums.reduce((a, b) => a + b, 0) / lums.length;
  const p95 = lums[Math.floor(lums.length * 0.95)];
  return { mean, p95, brightFrac: bright / lums.length };
}

async function loadRoot(page, embedURL, dir, rootBasename) {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.locator('input[type=file][webkitdirectory]').setInputFiles(dir);
  await expect(page.getByTestId('usd-scene-root-select')).toBeVisible({ timeout: 30000 });
  const rootCombobox = page.getByTestId('usd-scene-root-select').getByRole('combobox');
  if (await rootCombobox.count()) {
    await rootCombobox.click();
    const options = await page.getByRole('option').allTextContents();
    const selected = options.find((l) => l.endsWith('/' + rootBasename) || l === rootBasename);
    await page.getByRole('option', { name: selected, exact: true }).click();
  }
  await page.getByTestId('usd-scene-sidebar').getByRole('button', { name: /^Load (?!example)/ }).click();
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 180000 });
}

async function setDisplayTransform(page, value) {
  const combos = page.getByRole('combobox');
  for (let i = 0; i < await combos.count(); i++) {
    const el = combos.nth(i);
    const opts = await el.locator('option').allTextContents().catch(() => []);
    if (opts.some((o) => /lin_rec709|sRGB|ACES/.test(o))) {
      await el.selectOption(value).catch(() => {});
      return;
    }
  }
}

async function captureRun(page, embedURL, { dir, rootBasename, label, viewport, displayTransform }) {
  await page.setViewportSize(viewport || { width: 1400, height: 1100 });
  await loadRoot(page, embedURL, dir, rootBasename);
  if (displayTransform) await setDisplayTransform(page, displayTransform);
  await page.waitForTimeout(800);
  const warnText = await page.getByTestId('usd-material-warnings').count()
    ? await page.getByTestId('usd-material-warnings').innerText() : '';
  const pngPath = path.join(AB_DIR, label + '.png');
  const buf = await page.getByTestId('usd-scene-canvas').screenshot({ path: pngPath });
  const stats = boxStats(decodePNG(buf));
  return { label, pngPath, warnText, stats };
}

const results = [];

test.describe('@scene material A/B (opt-in)', () => {
  test.skip(!chessRoot && !stirlingRoot, 'Set USD_CHESS_ROOT and/or USD_STIRLING_ROOT to run this diagnostic.');

  test('Rook alone (2048 tier)', async ({ page, embedURL }) => {
    test.skip(!chessRoot, 'USD_CHESS_ROOT not set');
    const rookDir = path.join(path.dirname(chessRoot), 'assets', 'Rook');
    results.push(await captureRun(page, embedURL, { dir: rookDir, rootBasename: 'Rook.usd', label: 'rook-scene-2048-R0' }));
  });

  test('Full chess set (R0, tier check)', async ({ page, embedURL }) => {
    test.skip(!chessRoot, 'USD_CHESS_ROOT not set');
    const setDir = path.dirname(chessRoot);
    const r = await captureRun(page, embedURL, { dir: setDir, rootBasename: path.basename(chessRoot), label: 'rook-scene-fullset-R0' });
    results.push(r);
  });

  test('Rook R1 (roughness=0.5 constant)', async ({ page, embedURL }) => {
    test.skip(!chessRoot, 'USD_CHESS_ROOT not set');
    results.push(await captureRun(page, embedURL, { dir: path.join(AB_DIR, 'Rook_R1'), rootBasename: 'Rook.usd', label: 'rook-scene-2048-R1' }));
  });

  test('Rook R2 (no normal map)', async ({ page, embedURL }) => {
    test.skip(!chessRoot, 'USD_CHESS_ROOT not set');
    results.push(await captureRun(page, embedURL, { dir: path.join(AB_DIR, 'Rook_R2'), rootBasename: 'Rook.usd', label: 'rook-scene-2048-R2' }));
  });

  test('Stirling variants S0-S3', async ({ page, embedURL }) => {
    test.skip(!stirlingRoot, 'USD_STIRLING_ROOT not set');
    const dir = path.dirname(path.dirname(stirlingRoot)); // .../Stirling_MaterialX
    const rootBasename = path.basename(stirlingRoot);
    const mtlxPath = path.join(dir, 'materials', 'Real_Time', 'Car_Paint_MaterialX_Real_Time.mtlx');
    const original = fs.readFileSync(mtlxPath + '.orig', 'utf8');

    const withCoverageZero = (xml) => xml
      .replace(/(<flake3d name="mtlxflake3d2"[\s\S]*?<input name="coverage" type="float" value=")0\.8(")/, '$10$2')
      .replace(/(<flake3d name="mtlxflake3d1"[\s\S]*?<input name="coverage" type="float" value=")0\.7(")/, '$10$2');
    const withBumpBypassed = (xml) => xml
      .replace(/\s*<input name="normal" type="vector3" nodename="mtlxbump2" \/>/g, '')
      .replace(/\s*<input name="normal" type="vector3" nodename="mtlxbump1" \/>/g, '');

    const variants = {
      S0: original,
      S1: withCoverageZero(original),
      S2: withBumpBypassed(original),
      S3: withBumpBypassed(withCoverageZero(original)),
    };

    for (const [name, xml] of Object.entries(variants)) {
      fs.writeFileSync(mtlxPath, xml, 'utf8');
      results.push(await captureRun(page, embedURL, {
        dir, rootBasename, label: 'stirling-' + name,
        viewport: { width: 1600, height: 1200 },
      }));
    }
    fs.writeFileSync(mtlxPath, original, 'utf8'); // restore
  });

  test.afterAll(() => {
    const lines = ['# USD Scene material A/B results', ''];
    for (const r of results) {
      lines.push('## ' + r.label);
      lines.push('- png: ' + r.pngPath);
      lines.push('- mean=' + r.stats.mean.toFixed(2) + ' p95=' + r.stats.p95.toFixed(2) + ' brightFrac=' + r.stats.brightFrac.toFixed(4));
      lines.push('- warnings: ' + (r.warnText || '(none)'));
      lines.push('');
    }
    fs.writeFileSync(path.join(AB_DIR, 'RUN-RESULTS.md'), lines.join('\n'), 'utf8');
  });
});

// --- Round 2: Viewer-vs-Scene A/B, plus R3/R5 and Stirling near/far. ---
// Assets live entirely in Temp; see AB2_DIR below. Env vars reused from
// round 1 (USD_CHESS_ROOT / USD_STIRLING_ROOT) gate this block too.

const AB2_DIR = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\ab2';
fs.mkdirSync(AB2_DIR, { recursive: true });
const rookRoot = chessRoot ? path.join(path.dirname(chessRoot), 'assets', 'Rook') : '';

const results2 = [];
const jpgStats = { note: null };
const samplerInfo = { note: null };

async function loadViewerMaterial(page, embedURL, dir, viewport) {
  await page.setViewportSize(viewport || { width: 1400, height: 1100 });
  await page.goto(embedURL + '/index.html#!viewer');
  await page.locator('input[type=file][webkitdirectory]').setInputFiles(dir);
  await page.waitForFunction(() => !document.body.innerText.includes('Generating shader'), { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function setViewerDisplayTransform(page, value) {
  await page.evaluate((v) => { if (window.setDisplayTransform) window.setDisplayTransform(v); }, value);
  await page.waitForTimeout(500);
}

async function captureViewer(page, label) {
  const pngPath = path.join(AB2_DIR, label + '.png');
  const buf = await page.locator('canvas').first().screenshot({ path: pngPath });
  const stats = boxStats(decodePNG(buf));
  results2.push({ label, pngPath, stats });
  return { pngPath, stats };
}

async function captureScene2(page, label) {
  const pngPath = path.join(AB2_DIR, label + '.png');
  const buf = await page.getByTestId('usd-scene-canvas').screenshot({ path: pngPath });
  const stats = boxStats(decodePNG(buf));
  results2.push({ label, pngPath, stats });
  return { pngPath, stats };
}

test.describe('@scene material A/B round 2b (opt-in)', () => {
  test.skip(!chessRoot, 'Set USD_CHESS_ROOT to run this diagnostic.');

  test('Viewer V0 (Rook original)', async ({ page, embedURL }) => {
    await loadViewerMaterial(page, embedURL, rookRoot);
    await page.evaluate(() => { if (window.setDisplayTransform) window.setDisplayTransform('srgb'); });
    await page.waitForTimeout(500);
    await captureViewer(page, 'V0-viewer-rook-original');
  });

  test('Viewer V1 (roughness forced 0.5)', async ({ page, embedURL }) => {
    await loadViewerMaterial(page, embedURL, path.join(AB_DIR, 'Rook_R1'));
    await captureViewer(page, 'V1-viewer-rook-rough05');
  });

  test('Viewer V2 (normal map removed)', async ({ page, embedURL }) => {
    await loadViewerMaterial(page, embedURL, path.join(AB_DIR, 'Rook_R2'));
    await captureViewer(page, 'V2-viewer-rook-nonormal');
  });

  test('Viewer V3 (unlit roughness visualizer, lin_rec709)', async ({ page, embedURL }) => {
    await loadViewerMaterial(page, embedURL, path.join(AB2_DIR, 'Rook_R3'));
    await setViewerDisplayTransform(page, 'lin_rec709');
    await captureViewer(page, 'V3-viewer-rook-unlit-roughness');
  });

  // 2b: Scene leg — R0 original (+ sampler/texture-stats introspection),
  // R5 red base_color control (proves edits apply on the Scene leg).
  test('Scene R0 (Rook original) + sampler/texture stats', async ({ page, embedURL }) => {
    await captureRun(page, embedURL, { dir: rookRoot, rootBasename: 'Rook.usd', label: 'R0-scene-rook-original' })
      .then((r) => results2.push(r));
    const introspect = await page.evaluate(() => {
      const h = window.__mtlxUsdSceneHandle;
      if (!h) return { available: false };
      const out = { available: true };
      out.getSamplerReport = typeof h.getSamplerReport === 'function' ? h.getSamplerReport() : '(not a function)';
      out.getTextureStats = typeof h.getTextureStats === 'function' ? h.getTextureStats() : '(not a function)';
      return out;
    });
    samplerInfo.note = JSON.stringify(introspect, null, 2);
  });

  test('Scene R5 (base_color forced red, control)', async ({ page, embedURL }) => {
    const r = await captureRun(page, embedURL, { dir: path.join(AB2_DIR, 'Rook_R5'), rootBasename: 'Rook.usd', label: 'R5-scene-rook-red' });
    results2.push(r);
  });

  // 2c: Scene R3 unlit roughness visualizer, same lin_rec709 transform as V3.
  test('Scene R3 (unlit roughness visualizer, lin_rec709)', async ({ page, embedURL }) => {
    await captureRun(page, embedURL, { dir: path.join(AB2_DIR, 'Rook_R3'), rootBasename: 'Rook.usd', label: 'R3-scene-rook-unlit-roughness', displayTransform: 'lin_rec709' })
      .then((r) => results2.push(r));
  });

  // roughness jpg stats, decoded inside the running browser (not a
  // separate Node script): fetch bytes in Node, hand them to the page,
  // decode via createImageBitmap + OffscreenCanvas there.
  test('roughness jpg stats (rook_shared_roughness.jpg)', async ({ page, embedURL }) => {
    await page.goto(embedURL + '/index.html');
    const jpgPath = path.join(rookRoot, 'tex', 'rook_shared_roughness.jpg');
    const b64 = fs.readFileSync(jpgPath).toString('base64');
    const stats = await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'image/jpeg' });
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      const vals = [];
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        vals.push(r === g && g === b ? r : 0.2126 * r + 0.7152 * g + 0.0722 * b);
      }
      vals.sort((a, b) => a - b);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const p5 = vals[Math.floor(vals.length * 0.05)];
      const p95 = vals[Math.floor(vals.length * 0.95)];
      return { mean, p5, p95, width: bitmap.width, height: bitmap.height };
    }, b64);
    jpgStats.note = JSON.stringify(stats);
  });

  test.afterAll(() => {
    const lines = ['# Round 2 raw results', ''];
    for (const r of results2) {
      lines.push('## ' + r.label);
      lines.push('- png: ' + r.pngPath);
      lines.push('- mean=' + r.stats.mean.toFixed(2) + ' p95=' + r.stats.p95.toFixed(2) + ' brightFrac=' + r.stats.brightFrac.toFixed(4));
      lines.push('');
    }
    if (samplerInfo.note) { lines.push('## sampler/texture stats (R0)'); lines.push('```json'); lines.push(samplerInfo.note); lines.push('```'); }
    if (jpgStats.note) { lines.push('## roughness jpg stats'); lines.push(jpgStats.note); }
    fs.writeFileSync(path.join(AB2_DIR, 'RUN-RESULTS-2.md'), lines.join('\n'), 'utf8');
  });
});

test.describe('@scene material A/B round 2c Stirling (opt-in)', () => {
  test.skip(!stirlingRoot, 'Set USD_STIRLING_ROOT to run this diagnostic.');

  test('Stirling S0/S3/S5 near+far', async ({ page, embedURL }) => {
    const dir = path.dirname(path.dirname(stirlingRoot));
    const rootBasename = path.basename(stirlingRoot);
    const mtlxPath = path.join(dir, 'materials', 'Real_Time', 'Car_Paint_MaterialX_Real_Time.mtlx');
    const original = fs.readFileSync(mtlxPath + '.orig', 'utf8');

    const withCoverageZero = (xml) => xml
      .replace(/(<flake3d name="mtlxflake3d2"[\s\S]*?<input name="coverage" type="float" value=")0\.8(")/, '$10$2')
      .replace(/(<flake3d name="mtlxflake3d1"[\s\S]*?<input name="coverage" type="float" value=")0\.7(")/, '$10$2');
    const withBumpBypassed = (xml) => xml
      .replace(/\s*<input name="normal" type="vector3" nodename="mtlxbump2" \/>/g, '')
      .replace(/\s*<input name="normal" type="vector3" nodename="mtlxbump1" \/>/g, '');
    const withRedDiffuse = (xml) => xml
      .replace(/(<oren_nayar_diffuse_bsdf name="mtlxoren_nayar_diffuse_bsdf1"[\s\S]*?<input name="color" type="color3" value=")[^"]*(")/, '$11, 0, 0$2');

    const variants = {
      S0: original,
      S3: withBumpBypassed(withCoverageZero(original)),
      S5: withRedDiffuse(original),
    };

    for (const [name, xml] of Object.entries(variants)) {
      fs.writeFileSync(mtlxPath, xml, 'utf8');
      const far = await captureRun(page, embedURL, {
        dir, rootBasename, label: 'stirling-' + name + '-far',
        viewport: { width: 1600, height: 1200 },
      });
      results2.push(far);

      const cam = await page.evaluate(() => {
        const h = window.__mtlxUsdSceneHandle;
        return h && h.getCamera ? h.getCamera() : null;
      });
      if (cam) {
        const near = {
          position: cam.position.map((p, i) => p + (cam.target[i] - p) * 0.6),
          target: cam.target,
        };
        await page.evaluate((pose) => {
          const h = window.__mtlxUsdSceneHandle;
          if (h && h.setCamera) h.setCamera(pose);
        }, near);
        await page.waitForTimeout(300);
        const pngPath = path.join(AB2_DIR, 'stirling-' + name + '-near.png');
        const buf = await page.getByTestId('usd-scene-canvas').screenshot({ path: pngPath });
        const stats = boxStats(decodePNG(buf));
        results2.push({ label: 'stirling-' + name + '-near', pngPath, stats });
      } else {
        results2.push({ label: 'stirling-' + name + '-near', pngPath: '(no camera API)', stats: { mean: NaN, p95: NaN, brightFrac: NaN } });
      }
    }
    fs.writeFileSync(mtlxPath, original, 'utf8'); // restore
  });

  test.afterAll(() => {
    const lines = ['# Round 2 Stirling results', ''];
    for (const r of results2.filter((r) => r.label.startsWith('stirling-'))) {
      lines.push('## ' + r.label);
      lines.push('- png: ' + r.pngPath);
      lines.push('- mean=' + r.stats.mean.toFixed(2) + ' p95=' + r.stats.p95.toFixed(2) + ' brightFrac=' + r.stats.brightFrac.toFixed(4));
      lines.push('');
    }
    fs.writeFileSync(path.join(AB2_DIR, 'RUN-RESULTS-STIRLING.md'), lines.join('\n'), 'utf8');
  });
});
