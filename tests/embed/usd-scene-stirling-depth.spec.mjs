import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

// Depth-precision diagnosis for the Stirling sparkle. Opt-in only; set
// USD_STIRLING_ROOT to the Real_Time usda root under the Temp asset copy.
const suppliedRoot = process.env.USD_STIRLING_ROOT || '';
const suppliedDir = path.dirname(path.dirname(suppliedRoot));
const outDir = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\ab9';

function metrics(image) {
  const { width, height } = image;
  const x0 = Math.floor(width * 0.25), x1 = Math.floor(width * 0.75);
  const y0 = Math.floor(height * 0.25), y1 = Math.floor(height * 0.75);
  const lum = (x, y) => {
    const p = image.getPixel(x, y);
    return 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;
  };
  let sum = 0, count = 0, above230 = 0, sparkle = 0;
  const values = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const l = lum(x, y);
      values.push(l);
      sum += l;
      count++;
      if (l > 230) above230++;
      if (x > x0 && x < x1 - 1 && y > y0 && y < y1 - 1) {
        let nsum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) nsum += lum(x + dx, y + dy);
        const nmean = nsum / 9;
        if (l - nmean > 40) sparkle++;
      }
    }
  }
  values.sort((a, b) => a - b);
  const p95 = values[Math.floor(values.length * 0.95)];
  return { mean: sum / count, p95, frac230: above230 / count, sparkleFrac: sparkle / count };
}

async function loadAsset(page, embedURL) {
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
    const selectedRoot = options.find((label) => label.endsWith('/' + rootName) || label === rootName)
      || options.find((label) => label.toLowerCase().includes('real_time') && label.toLowerCase().endsWith('.usda'));
    await page.getByRole('option', { name: selectedRoot, exact: true }).click();
    await expect(rootCombobox).toContainText(selectedRoot);
  }
  await page.getByTestId('usd-scene-sidebar').getByRole('button', { name: /^Load (?!example)/ }).click();
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 180000 });
  await expect(page.getByTestId('usd-scene-canvas').locator('canvas')).toHaveCount(1);
}

async function frameHoodCloseup(page) {
  await page.evaluate(() => {
    const handle = window.__mtlxUsdSceneHandle;
    const pose = handle.getCamera();
    const newPos = pose.position.map((p, i) => p + 0.6 * (pose.target[i] - p));
    handle.setCamera({ position: newPos, target: pose.target });
  });
}

async function twoFrames(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function shoot(page, name) {
  const p = path.join(outDir, name + '.png');
  await page.getByTestId('usd-scene-canvas').locator('canvas').screenshot({ path: p });
  return p;
}

test('@scene diagnoses Stirling sparkle depth precision', async ({ page, embedURL }) => {
  test.skip(!suppliedRoot, 'Set USD_STIRLING_ROOT to run this bounded diagnosis.');
  test.setTimeout(1800000);
  fs.mkdirSync(outDir, { recursive: true });

  const results = {};
  const shots = {};

  await page.setViewportSize({ width: 1600, height: 1200 });
  await loadAsset(page, embedURL);
  await frameHoodCloseup(page);
  await twoFrames(page);

  // Z0: baseline camera state and capture.
  const z0State = await page.evaluate(() => {
    const handle = window.__mtlxUsdSceneHandle;
    const dbg = handle.__debug();
    const pose = handle.getCamera();
    const cam = dbg.camera;
    const dx = pose.position[0] - pose.target[0];
    const dy = pose.position[1] - pose.target[1];
    const dz = pose.position[2] - pose.target[2];
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return {
      near: cam.near,
      far: cam.far,
      position: pose.position,
      target: pose.target,
      distance,
    };
  });
  shots.Z0 = await shoot(page, 'Z0-baseline');
  results.Z0 = metrics(decodePNG(fs.readFileSync(shots.Z0)));

  // Largest-triangle-count meshes (Z6 lightweight version).
  const meshInventory = await page.evaluate(() => {
    const dbg = window.__mtlxUsdSceneHandle.__debug();
    const rows = [];
    dbg.scene.traverse((obj) => {
      if (obj.isMesh && obj.geometry) {
        const geom = obj.geometry;
        const index = geom.index;
        const posAttr = geom.attributes && geom.attributes.position;
        const triCount = index ? index.count / 3 : (posAttr ? posAttr.count / 3 : 0);
        rows.push({ name: obj.name || '(unnamed)', triCount });
      }
    });
    rows.sort((a, b) => b.triCount - a.triCount);
    return rows.slice(0, 10);
  });

  // Z1: near = 0.05.
  await page.evaluate(() => {
    const dbg = window.__mtlxUsdSceneHandle.__debug();
    dbg.camera.near = 0.05;
    dbg.camera.updateProjectionMatrix();
  });
  await twoFrames(page);
  shots.Z1 = await shoot(page, 'Z1-near0.05');
  results.Z1 = metrics(decodePNG(fs.readFileSync(shots.Z1)));

  // Z2: near = 0.2.
  await page.evaluate(() => {
    const dbg = window.__mtlxUsdSceneHandle.__debug();
    dbg.camera.near = 0.2;
    dbg.camera.updateProjectionMatrix();
  });
  await twoFrames(page);
  shots.Z2 = await shoot(page, 'Z2-near0.2');
  results.Z2 = metrics(decodePNG(fs.readFileSync(shots.Z2)));

  // Z3: near = 0.2, far = 50.
  await page.evaluate(() => {
    const dbg = window.__mtlxUsdSceneHandle.__debug();
    dbg.camera.near = 0.2;
    dbg.camera.far = 50;
    dbg.camera.updateProjectionMatrix();
  });
  await twoFrames(page);
  shots.Z3 = await shoot(page, 'Z3-near0.2-far50');
  results.Z3 = metrics(decodePNG(fs.readFileSync(shots.Z3)));

  // Z4: restore original near/far, must match Z0.
  await page.evaluate((s) => {
    const dbg = window.__mtlxUsdSceneHandle.__debug();
    dbg.camera.near = s.near;
    dbg.camera.far = s.far;
    dbg.camera.updateProjectionMatrix();
  }, z0State);
  await twoFrames(page);
  shots.Z4 = await shoot(page, 'Z4-restored');
  results.Z4 = metrics(decodePNG(fs.readFileSync(shots.Z4)));

  // Z5: polygon offset on every RawShaderMaterial, then revert.
  await page.evaluate(() => {
    const dbg = window.__mtlxUsdSceneHandle.__debug();
    window.__z5Touched = [];
    dbg.scene.traverse((obj) => {
      if (!obj.isMesh) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => {
        if (m && m.isRawShaderMaterial) {
          window.__z5Touched.push(m);
          m.polygonOffset = true;
          m.polygonOffsetFactor = 1;
          m.polygonOffsetUnits = 1;
          m.needsUpdate = true;
        }
      });
    });
  });
  await twoFrames(page);
  shots.Z5 = await shoot(page, 'Z5-polygonoffset');
  results.Z5 = metrics(decodePNG(fs.readFileSync(shots.Z5)));
  const z5Count = await page.evaluate(() => {
    (window.__z5Touched || []).forEach((m) => {
      m.polygonOffset = false;
      m.polygonOffsetFactor = 0;
      m.polygonOffsetUnits = 0;
      m.needsUpdate = true;
    });
    const n = (window.__z5Touched || []).length;
    delete window.__z5Touched;
    return n;
  });
  await twoFrames(page);

  const z0z4Match = Math.abs(results.Z0.mean - results.Z4.mean) < 0.5
    && Math.abs(results.Z0.sparkleFrac - results.Z4.sparkleFrac) < 0.0005;

  const zKeys = ['Z0', 'Z1', 'Z2', 'Z3', 'Z4', 'Z5'];
  const rows = zKeys.map((k) => {
    const r = results[k];
    return `| ${k} | ${r.mean.toFixed(2)} | ${r.p95.toFixed(2)} | ${(r.frac230 * 100).toFixed(3)}% | ${(r.sparkleFrac * 100).toFixed(3)}% |`;
  });

  // Z3 clamps far below the camera-to-target distance, so a near-black
  // mean there means the whole scene got clipped, not that z-fighting
  // resolved. Only treat Z3 as supporting evidence when it did not clip.
  const z3Clipped = results.Z3.mean < results.Z0.mean * 0.5;
  const speckleReduced = results.Z1.sparkleFrac < results.Z0.sparkleFrac * 0.5
    || results.Z2.sparkleFrac < results.Z0.sparkleFrac * 0.5
    || (!z3Clipped && results.Z3.sparkleFrac < results.Z0.sparkleFrac * 0.5);

  const verdict = speckleReduced
    ? 'Z1-Z3 sharply reduce the sparkle proxy relative to Z0: consistent with depth-buffer z-fighting. Fix the near-plane policy in frameAll (and/or derive near per-frame from camera-to-target distance in the render loop).'
    : 'Z1-Z2 do NOT reduce the sparkle proxy relative to Z0 (Z3 is inconclusive if it clipped the scene instead of just tightening precision, see the mean below): not z-fighting from the global near/far policy. See Z5 (polygon offset) for a shell-overlap-specific check.';

  const report = [
    '# Stirling sparkle depth-precision diagnosis',
    '',
    '## Z0 baseline camera state',
    '',
    `- near: ${z0State.near}`,
    `- far: ${z0State.far}`,
    `- position: [${z0State.position.map((n) => n.toFixed(4)).join(', ')}]`,
    `- target: [${z0State.target.map((n) => n.toFixed(4)).join(', ')}]`,
    `- distance camera-to-target: ${z0State.distance.toFixed(4)}`,
    '',
    '## Metrics (central 50% box)',
    '',
    '| Capture | mean | p95 | frac>230 | sparkle proxy |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    `Z0 vs Z4 (restored) match: ${z0z4Match ? 'yes' : 'NO — camera state did not restore cleanly'}`,
    `Z3 scene clipped by far=50 (mean fell below half of Z0): ${z3Clipped ? 'yes, Z3 is inconclusive' : 'no'}`,
    `Z5 RawShaderMaterial count touched: ${z5Count}`,
    '',
    '## Top 10 meshes by triangle count',
    '',
    '| name | triangles |',
    '|---|---|',
    ...meshInventory.map((m) => `| ${m.name} | ${m.triCount} |`),
    '',
    '## Verdict',
    '',
    verdict,
    '',
    '## Screenshots',
    '',
    ...Object.entries(shots).map(([k, p]) => `- ${k}: ${p}`),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'REPORT.md'), report, 'utf8');

  // eslint-disable-next-line no-console
  console.log(report);
});
