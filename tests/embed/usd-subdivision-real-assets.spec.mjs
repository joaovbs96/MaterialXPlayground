// Not part of any CI tier: opt-in real-asset check for Loop subdivision.
// Loads the Rook alone and the full chess set in #!scene at subdivision 1
// and 2 (default), the Teapot, and the Stirling scene, screenshots each
// into ab7, and logs load time (ms) from the Loading overlay timing.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './lib/test-base.mjs';

const chessRoot = process.env.USD_CHESS_ROOT || '';
const rookRoot = chessRoot ? path.join(path.dirname(chessRoot), 'assets', 'Rook') : '';
const teapotRoot = process.env.USD_TEAPOT_ROOT || '';
const stirlingFile = process.env.USD_STIRLING_FILE || '';
const OUT_DIR = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\ab7';
fs.mkdirSync(OUT_DIR, { recursive: true });

async function loadDir(page, embedURL, dir, rootBasename, subdivisionLevel) {
  page.on('console', (msg) => { if (msg.type() === 'error') console.log('PAGE ERROR:', msg.text()); });
  page.on('pageerror', (err) => console.log('PAGE EXCEPTION:', err.message));
  page.on('crash', () => console.log('PAGE CRASHED'));
  // Navigate to the app's own origin first: setting localStorage before
  // navigation targets about:blank's opaque origin and is silently lost.
  await page.goto(embedURL + '/index.html#!scene');
  await page.evaluate((v) => { try { localStorage.setItem('mtlx_scene_subdivision', String(v)); } catch (e) {} }, subdivisionLevel);
  await page.reload();
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.locator('input[type=file][webkitdirectory]').setInputFiles(dir);
  const rootSelectVisible = await page.getByTestId('usd-scene-root-select').isVisible().catch(() => false);
  if (rootSelectVisible) {
    const rootCombobox = page.getByTestId('usd-scene-root-select').getByRole('combobox');
    await rootCombobox.click();
    const options = await page.getByRole('option').allTextContents();
    const selected = options.find((l) => l.endsWith('/' + rootBasename) || l === rootBasename);
    if (selected) await page.getByRole('option', { name: selected, exact: true }).click();
  }
  const start = Date.now();
  await page.getByTestId('usd-scene-sidebar').getByRole('button', { name: /^Load (?!example)/ }).click();
  try {
    await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 180000 });
  } catch (e) {
    const errText = await page.getByTestId('usd-scene-error').textContent({ timeout: 3000 }).catch(() => null);
    throw new Error(`Scene load failed. App error: ${errText}. Original: ${e.message}`);
  }
  const loadMs = Date.now() - start;
  await page.waitForTimeout(800);
  return loadMs;
}

async function readStats(page) {
  const warnings = await page.getByTestId('usd-material-warnings').textContent({ timeout: 3000 }).catch(() => '');
  const storedLevel = await page.evaluate(() => { try { return localStorage.getItem('mtlx_scene_subdivision'); } catch (e) { return null; } });
  const triangles = await page.getByTestId('usd-stage-triangles').textContent({ timeout: 3000 }).catch(() => null);
  return { warnings, storedLevel, triangles };
}

test.describe('@scene Subdivision real-asset check (opt-in)', () => {
  test.setTimeout(600000);

  for (const level of [1, 2]) {
    test(`Rook alone at subdivision ${level}`, async ({ page, embedURL }) => {
      test.skip(!rookRoot, 'Set USD_CHESS_ROOT to run.');
      await page.setViewportSize({ width: 1400, height: 1100 });
      const ms = await loadDir(page, embedURL, rookRoot, 'Rook.usd', level);
      await page.getByTestId('usd-scene-canvas').screenshot({ path: path.join(OUT_DIR, `real-rook-sub${level}.png`) });
      const stats = await readStats(page);
      console.log(`ROOK sub${level}: ${ms}ms, storedLevel=${stats.storedLevel}, triangles=${stats.triangles}, warnings=${JSON.stringify(stats.warnings || '')}`);
    });
  }

  for (const level of [1, 2]) {
    test(`Full chess set at subdivision ${level}`, async ({ page, embedURL }) => {
      test.skip(!chessRoot, 'Set USD_CHESS_ROOT to run.');
      await page.setViewportSize({ width: 1400, height: 1100 });
      const dir = path.dirname(chessRoot);
      const rootBasename = path.basename(chessRoot);
      const ms = await loadDir(page, embedURL, dir, rootBasename, level);
      await page.getByTestId('usd-scene-canvas').screenshot({ path: path.join(OUT_DIR, `real-chessset-sub${level}.png`) });
      const stats = await readStats(page);
      console.log(`CHESSSET sub${level}: ${ms}ms, storedLevel=${stats.storedLevel}, triangles=${stats.triangles}, warnings=${JSON.stringify(stats.warnings || '')}`);
    });
  }

  test('Teapot at default subdivision', async ({ page, embedURL }) => {
    test.skip(!teapotRoot, 'Set USD_TEAPOT_ROOT to run.');
    await page.setViewportSize({ width: 1400, height: 1100 });
    const ms = await loadDir(page, embedURL, teapotRoot, 'teapot.usda', 1);
    await page.getByTestId('usd-scene-canvas').screenshot({ path: path.join(OUT_DIR, 'real-teapot-sub1.png') });
    const stats = await readStats(page);
    console.log(`TEAPOT sub1: ${ms}ms, storedLevel=${stats.storedLevel}, triangles=${stats.triangles}, warnings=${JSON.stringify(stats.warnings || '')}`);
  });

  test('Stirling at default subdivision', async ({ page, embedURL }) => {
    test.skip(!stirlingFile, 'Set USD_STIRLING_FILE to run.');
    await page.setViewportSize({ width: 1400, height: 1100 });
    // Assets folder is the grandparent of the .usda root (usd/<file> under
    // Stirling_MaterialX/), so textures/materials resolve by relative path.
    const stirlingAssetsRoot = path.dirname(path.dirname(stirlingFile));
    const ms = await loadDir(page, embedURL, stirlingAssetsRoot, path.basename(stirlingFile), 1);
    await page.getByTestId('usd-scene-canvas').screenshot({ path: path.join(OUT_DIR, 'real-stirling-sub1.png') });
    const stats = await readStats(page);
    console.log(`STIRLING sub1: ${ms}ms, storedLevel=${stats.storedLevel}, triangles=${stats.triangles}, warnings=${JSON.stringify(stats.warnings || '')}`);
  });
});
