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
const STAGE_WAIT_CAP_MS = 480000;
const POLL_INTERVAL_MS = 15000;

function log(...args) {
  console.log('[playground]', new Date().toISOString(), ...args);
}

// Polls usd-scene-status text every POLL_INTERVAL_MS instead of a single
// blocking wait, so a stall is visible in the run's own console output
// (this is a headed, long-lived upload+render, not a normal fast spec).
// Returns { rendered, lastStatus, elapsedMs }.
async function pollStageStatus(page, capMs) {
  const started = Date.now();
  let lastStatus = '';
  while (Date.now() - started < capMs) {
    lastStatus = await page.getByTestId('usd-scene-status').textContent().catch(() => '');
    log('usd-scene-status =', JSON.stringify(lastStatus), '(elapsed ' + Math.round((Date.now() - started) / 1000) + 's)');
    if (/rendered/i.test(lastStatus || '')) return { rendered: true, lastStatus, elapsedMs: Date.now() - started };
    if (/error/i.test(lastStatus || '')) return { rendered: false, lastStatus, elapsedMs: Date.now() - started };
    await page.waitForTimeout(POLL_INTERVAL_MS);
  }
  return { rendered: false, lastStatus, elapsedMs: Date.now() - started };
}

// Shared by the main stage pass and the two wrapper-layer probes below.
// `rootBasename` is the .usda filename (already uploaded as part of the
// folder) to pick in the root selector; defaults to the real stage.
async function loadSceneStage(page, embedURL, rootBasename, screenshotName, reportHeading) {
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  const lines = [];
  lines.push('# ' + reportHeading);
  lines.push('');
  lines.push('Root: ' + rootBasename);
  lines.push('');

  log(rootBasename, 'goto #!scene');
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();

  log(rootBasename, 'uploading folder (setInputFiles) ...', suppliedDir);
  const uploadStart = Date.now();
  await page.locator('input[type=file][webkitdirectory]').setInputFiles(suppliedDir);
  log(rootBasename, 'upload done in', Math.round((Date.now() - uploadStart) / 1000) + 's');

  const rootSelectWrap = page.getByTestId('usd-scene-root-select');
  let rootPicked = null;
  try {
    await expect(rootSelectWrap).toBeVisible({ timeout: 30000 });
    const rootCombobox = rootSelectWrap.getByRole('combobox');
    if (await rootCombobox.count()) {
      await rootCombobox.click();
      const options = await page.getByRole('option').allTextContents();
      rootPicked = options.find((label) => label.endsWith('/' + rootBasename) || label === rootBasename);
      if (rootPicked) {
        await page.getByRole('option', { name: rootPicked, exact: true }).click();
        await expect(rootCombobox).toContainText(rootPicked);
      }
    }
  } catch (e) {
    log(rootBasename, 'root select did not appear (single root, or a different flow):', String(e && e.message || e));
  }

  log(rootBasename, 'clicking Load ...');
  await page.getByTestId('usd-scene-sidebar').getByRole('button', { name: /^Load (?!example)/ }).click();

  const result = await pollStageStatus(page, STAGE_WAIT_CAP_MS);
  log(rootBasename, 'poll finished', JSON.stringify(result));

  const stageCounts = await page.getByTestId('usd-stage-counts').textContent().catch(() => '(unavailable)');
  const wasmAborted = pageErrors.some((e) => /abort|out of memory|RuntimeError/i.test(e))
    || consoleErrors.some((e) => /abort|out of memory|RuntimeError/i.test(e));

  await page.getByTestId('usd-scene-canvas').locator('canvas')
    .screenshot({ path: path.join(OUT_DIR, screenshotName) }).catch((e) => log(rootBasename, 'screenshot failed:', String(e)));

  lines.push('Root picked: ' + (rootPicked || '(n/a, single root or root select skipped)'));
  lines.push('Upload time: ' + Math.round((Date.now() - uploadStart) / 1000) + 's');
  lines.push('');
  lines.push('## Result');
  lines.push('- rendered: ' + result.rendered);
  lines.push('- last usd-scene-status text: ' + JSON.stringify(result.lastStatus));
  lines.push('- elapsed waiting for stage: ' + Math.round(result.elapsedMs / 1000) + 's (cap ' + (STAGE_WAIT_CAP_MS / 1000) + 's)');
  lines.push('- last sidebar stage counts: ' + JSON.stringify(stageCounts));
  lines.push('- wasm appears to have aborted: ' + wasmAborted);
  lines.push('');

  if (result.rendered) {
    const warnings = await page.getByTestId('usd-material-warnings').allTextContents().catch(() => []);
    const samplerReport = await page.evaluate(() => window.__mtlxUsdSceneHandle && window.__mtlxUsdSceneHandle.getSamplerReport()).catch(() => null);
    const textureStats = await page.evaluate(() => window.__mtlxUsdSceneHandle && window.__mtlxUsdSceneHandle.getTextureStats()).catch(() => null);
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
  } else {
    lines.push('## Stage did not reach "rendered" within the cap');
    lines.push('The stage stalled; see the status/counts above.');
  }
  lines.push('');
  lines.push('## Console errors (' + consoleErrors.length + ')');
  consoleErrors.forEach((e) => lines.push('- ' + e));
  lines.push('');
  lines.push('## Page errors (' + pageErrors.length + ')');
  pageErrors.forEach((e) => lines.push('- ' + e));
  lines.push('');
  lines.push('Screenshot: ' + screenshotName);
  lines.push('');

  return lines.join('\n');
}

test('@scene opt-in: OpenPBR Shader Playground full stage pass', async ({ page, embedURL }) => {
  test.skip(!suppliedRoot, 'Set USD_PLAYGROUND_ROOT to run this opt-in pass.');
  test.setTimeout(590000);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const report = await loadSceneStage(
    page, embedURL, path.basename(suppliedRoot), 'stage.png',
    'OpenPBR Shader Playground pass',
  );
  const note = '\nNote: the unmodified stage aborts the wasm on invalid indexed\n'
    + 'primvars:normals authored on /World/dresser_grp/dresserFrame_geo (see the\n'
    + 'ComputeFlattened warning above). This is a runtime limitation of the\n'
    + 'pinned usd-wg-webview OpenUSD build surfacing a pre-existing data defect\n'
    + 'in the asset; the two wrapper-layer probes below test whether blocking\n'
    + 'or deactivating just that mesh lets the rest of the stage load. Not\n'
    + 'fixed here (out of scope for this package, and not an engine bug).\n';
  fs.writeFileSync(path.join(OUT_DIR, 'REPORT.md'), report + note, 'utf8');
  log('wrote REPORT.md');
});

// Wrapper-layer probes (coordinator-directed): each is a tiny self-authored
// USD layer that sub-layers the real stage and overrides ONLY the mesh
// whose indexed primvars:normals aborts the wasm (see the stage pass above).
// Variant A blocks the broken attributes (opinion-erasing None values);
// Variant B deactivates the whole prim. Both wrapper .usda files must sit
// beside the real stage for their relative `@./ShdrPlygrnd_OpenPBR.usda@`
// sublayer to resolve once uploaded through the same folder input; the
// orchestrator places and removes those sibling copies, not this spec.
const WRAPPER_PROBES = [
  { file: 'ShdrPlygrnd_OpenPBR_blocknormals.usda', shot: 'stage-blocknormals.png', label: 'Variant A (primvars:normals blocked to None)' },
  { file: 'ShdrPlygrnd_OpenPBR_nodresser.usda', shot: 'stage-nodresser.png', label: 'Variant B (dresserFrame_geo deactivated)' },
];

for (const probe of WRAPPER_PROBES) {
  test('@scene opt-in: OpenPBR Shader Playground wrapper probe - ' + probe.label, async ({ page, embedURL }) => {
    test.skip(!suppliedRoot, 'Set USD_PLAYGROUND_ROOT to run this opt-in pass.');
    test.setTimeout(590000);
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const wrapperPath = path.join(suppliedDir, probe.file);
    test.skip(!fs.existsSync(wrapperPath), 'Wrapper layer ' + probe.file + ' not present beside the stage; see the coordinator note.');

    const report = await loadSceneStage(
      page, embedURL, probe.file, probe.shot,
      'OpenPBR Shader Playground wrapper probe - ' + probe.label,
    );
    fs.appendFileSync(path.join(OUT_DIR, 'REPORT.md'), '\n---\n\n' + report, 'utf8');
    log(probe.file, 'appended wrapper probe result to REPORT.md');
  });
}

const VIEWER_MATERIALS = ['bubblesMasonJar.mtlx', 'floor.mtlx', 'iceCube.mtlx'];

for (const name of VIEWER_MATERIALS) {
  test('@viewer opt-in: OpenPBR Shader Playground material ' + name, async ({ page, embedURL }) => {
    test.skip(!suppliedRoot, 'Set USD_PLAYGROUND_ROOT to run this opt-in pass.');
    test.setTimeout(590000);
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    log(name, 'goto #!viewer');
    await page.goto(embedURL + '/index.html#!viewer');

    log(name, 'uploading folder ...');
    const uploadStart = Date.now();
    await page.locator('input[type=file][webkitdirectory]').setInputFiles(suppliedDir);
    log(name, 'upload done in', Math.round((Date.now() - uploadStart) / 1000) + 's');

    // Several .mtlx documents load; the "Pick a document" MtlxSelect lists
    // them by their relative path (e.g. "materials/bubblesMasonJar.mtlx"),
    // not the bare filename, so match by suffix through the combobox.
    // Click the visible placeholder text itself (inside the MtlxSelect
    // trigger button); .click()'s own actionability wait covers the delay
    // while hundreds of dropped files (many multi-ten-MB textures) ingest.
    const picker = page.getByText('Pick a .mtlx', { exact: false });
    await picker.click({ timeout: 180000 });
    const optionTexts = await page.getByRole('option').allTextContents();
    const optionLabel = optionTexts.find((t) => t.endsWith('/' + name) || t === name);
    if (!optionLabel) throw new Error('No document option ending in "' + name + '" found among: ' + optionTexts.join(', '));
    await page.getByRole('option', { name: optionLabel, exact: true }).click();
    log(name, 'document selected (' + optionLabel + '), waiting for shader generation to finish');
    // The folder ingest auto-picks a default document before our explicit
    // pick lands, so "Generating shader..." can hide and reappear once;
    // require it absent on two consecutive checks before trusting it's done.
    const overlay = page.getByText('Generating shader', { exact: false });
    const deadline = Date.now() + 60000;
    let stableCount = 0;
    while (Date.now() < deadline && stableCount < 2) {
      const visible = await overlay.isVisible().catch(() => false);
      stableCount = visible ? 0 : stableCount + 1;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(500); // a beat for the first frame to paint

    const canvas = page.locator('canvas').first();
    await canvas.screenshot({ path: path.join(OUT_DIR, name.replace(/\.mtlx$/, '') + '.png') });
    fs.appendFileSync(
      path.join(OUT_DIR, 'REPORT.md'),
      '\n## Viewer material: ' + name + '\nConsole errors: ' + consoleErrors.length
        + (consoleErrors.length ? '\n- ' + consoleErrors.join('\n- ') : '') + '\n',
      'utf8',
    );
    log(name, 'done');
  });
}
