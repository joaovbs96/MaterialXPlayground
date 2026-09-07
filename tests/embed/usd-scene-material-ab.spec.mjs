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
