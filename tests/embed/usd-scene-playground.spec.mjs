// tests/embed/usd-scene-playground.spec.mjs: opt-in pass over the OpenPBR
// Shader Playground asset (54 materials, many geompropvalue(vector2)-only
// UV sources). Set USD_PLAYGROUND_ROOT to the ShdrPlygrnd_OpenPBR.usda path
// in place; skipped otherwise. Dumps a report instead of asserting much,
// since the goal is visibility into remaining warnings, not a pass/fail gate.

import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './lib/test-base.mjs';

const suppliedRoot = process.env.USD_PLAYGROUND_ROOT || '';
const suppliedDir = suppliedRoot ? path.dirname(suppliedRoot) : '';
const OUT_DIR = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\pg1';

async function loadSceneAsset(page, embedURL) {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.locator('input[type=file][webkitdirectory]').setInputFiles(suppliedDir);
  await expect(page.getByTestId('usd-scene-root-select')).toBeVisible({ timeout: 30000 });
  const rootSelectWrap = page.getByTestId('usd-scene-root-select');
  const rootCombobox = rootSelectWrap.getByRole('combobox');
  if (await rootCombobox.count()) {
    await rootCombobox.click();
    const options = await page.getByRole('option').allTextContents();
    const rootName = path.basename(suppliedRoot);
    const selectedRoot = options.find((label) => label.endsWith('/' + rootName) || label === rootName);
    if (selectedRoot) {
      await page.getByRole('option', { name: selectedRoot, exact: true }).click();
      await expect(rootCombobox).toContainText(selectedRoot);
    }
  }
  await page.getByTestId('usd-scene-sidebar').getByRole('button', { name: /^Load (?!example)/ }).click();
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 600000 });
}

test('@scene opt-in: OpenPBR Shader Playground full stage pass', async ({ page, embedURL }) => {
  test.skip(!suppliedRoot, 'Set USD_PLAYGROUND_ROOT to run this opt-in pass.');
  test.setTimeout(900000);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await loadSceneAsset(page, embedURL);

  const warnings = await page.getByTestId('usd-material-warnings').allTextContents();
  const samplerReport = await page.evaluate(() => window.__mtlxUsdSceneHandle.getSamplerReport());
  const textureStats = await page.evaluate(() => window.__mtlxUsdSceneHandle.getTextureStats());

  await page.getByTestId('usd-scene-canvas').locator('canvas')
    .screenshot({ path: path.join(OUT_DIR, 'stage.png') });

  const lines = [];
  lines.push('# OpenPBR Shader Playground pass');
  lines.push('');
  lines.push('Root: ' + suppliedRoot);
  lines.push('');
  lines.push('## Material warnings (' + warnings.length + ')');
  warnings.forEach((w) => lines.push('- ' + w));
  lines.push('');
  lines.push('## Sampler report');
  lines.push('```json');
  lines.push(JSON.stringify(samplerReport, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Texture stats');
  lines.push('```json');
  lines.push(JSON.stringify(textureStats, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Console errors (' + consoleErrors.length + ')');
  consoleErrors.forEach((e) => lines.push('- ' + e));
  lines.push('');
  lines.push('## Page errors (' + pageErrors.length + ')');
  pageErrors.forEach((e) => lines.push('- ' + e));
  lines.push('');
  lines.push('Screenshot: stage.png');

  fs.writeFileSync(path.join(OUT_DIR, 'REPORT.md'), lines.join('\n'), 'utf8');
});

const VIEWER_MATERIALS = ['bubblesMasonJar.mtlx', 'floor.mtlx', 'iceCube.mtlx'];

for (const name of VIEWER_MATERIALS) {
  test('@viewer opt-in: OpenPBR Shader Playground material ' + name, async ({ page, embedURL }) => {
    test.skip(!suppliedRoot, 'Set USD_PLAYGROUND_ROOT to run this opt-in pass.');
    test.setTimeout(300000);
    fs.mkdirSync(OUT_DIR, { recursive: true });

    await page.goto(embedURL + '/index.html#!viewer');
    await page.locator('input[type=file][webkitdirectory]').setInputFiles(suppliedDir);
    // Several .mtlx documents load; the Files panel lists them, pick the one
    // named after this material.
    await page.getByText(name, { exact: true }).click();
    await page.waitForTimeout(3000);

    await page.getByTestId('usd-scene-viewer').first().waitFor({ state: 'hidden' }).catch(() => {});
    const canvas = page.locator('canvas').first();
    await canvas.screenshot({ path: path.join(OUT_DIR, name.replace(/\.mtlx$/, '') + '.png') });
  });
}
