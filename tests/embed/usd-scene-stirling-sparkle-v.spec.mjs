import fs from 'node:fs';
import path from 'node:path';
import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';
import { makeFlatHdr } from './lib/env-fixtures.mjs';

// Round B: isolate the Stirling sparkle among the three remaining shading
// inputs (vertex normals, environment content, analytic lights) since every
// material node and depth/texture knob has already been ruled out.
const suppliedRoot = process.env.USD_STIRLING_ROOT || '';
const suppliedDir = path.dirname(path.dirname(suppliedRoot));
const outDir = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\ab10';
const ENVIRONMENT_INPUT = 'input[type=file][accept=".hdr,.exr"]';

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

test('@scene isolates the Stirling sparkle among normals, env, and lights', async ({ page, embedURL }) => {
  test.skip(!suppliedRoot, 'Set USD_STIRLING_ROOT to run this bounded diagnosis.');
  test.setTimeout(1800000);
  fs.mkdirSync(outDir, { recursive: true });

  const results = {};
  const shots = {};
  const notes = {};

  page.on('console', (msg) => { if (msg.type() === 'error') notes.lastConsoleError = msg.text(); });

  await page.setViewportSize({ width: 1600, height: 1200 });
  await loadAsset(page, embedURL);
  await frameHoodCloseup(page);
  await twoFrames(page);

  // N0: baseline.
  shots.N0 = await shoot(page, 'N0-baseline');
  results.N0 = metrics(decodePNG(fs.readFileSync(shots.N0)));

  // N1: replace every RawShaderMaterial fragment shader with a normal-color
  // visualizer, restoring the originals afterward.
  const n1 = await page.evaluate(() => {
    const dbg = window.__mtlxUsdSceneHandle.__debug();
    const touched = [];
    let varyingUsed = null;
    let firstFailure = null;
    window.__n1Originals = window.__n1Originals || new Map();
    dbg.materials.forEach((m, idx) => {
      if (!m || !m.isRawShaderMaterial || !m.fragmentShader) return;
      const src = m.fragmentShader;
      const mainIdx = src.indexOf('void main');
      if (mainIdx < 0) return;
      const header = src.slice(0, mainIdx);
      // Find the interpolated world-normal varying: MaterialX names it
      // normalWorld, usually inside a VertexData struct instance called vd.
      let varying = null;
      if (/\bvd\.normalWorld\b/.test(src) || /struct\s+VertexData[\s\S]{0,400}?normalWorld/.test(src)) {
        varying = 'vd.normalWorld';
      } else if (/\bnormalWorld\b/.test(src)) {
        varying = 'normalWorld';
      } else {
        return; // no known world-normal varying on this material, skip it
      }
      if (!varyingUsed) varyingUsed = varying;
      const outMatch = header.match(/out\s+vec4\s+(\w+)\s*;/);
      const outName = outMatch ? outMatch[1] : 'fragColor';
      const declareOut = outMatch ? '' : 'out vec4 fragColor;\n';
      const newSrc = header + declareOut
        + 'void main() {\n'
        + '  vec3 n = normalize(' + varying + ');\n'
        + '  ' + outName + ' = vec4(n * 0.5 + 0.5, 1.0);\n'
        + '}\n';
      window.__n1Originals.set(m, src);
      m.fragmentShader = newSrc;
      m.needsUpdate = true;
      touched.push(idx);
    });
    return { touchedCount: touched.length, varyingUsed, materialCount: dbg.materials.length };
  });
  await twoFrames(page);
  const n1CompileErrors = await page.evaluate(() => {
    const dbg = window.__mtlxUsdSceneHandle.__debug();
    const progs = dbg.renderer.info.programs || [];
    return progs.filter((p) => p.diagnostics && p.diagnostics.programLog).map((p) => p.diagnostics.programLog);
  });
  shots.N1 = await shoot(page, 'N1-normals');
  results.N1 = metrics(decodePNG(fs.readFileSync(shots.N1)));
  notes.n1 = n1;
  notes.n1CompileErrors = n1CompileErrors;

  // Restore N1 originals.
  await page.evaluate(() => {
    const dbg = window.__mtlxUsdSceneHandle.__debug();
    dbg.materials.forEach((m) => {
      if (window.__n1Originals && window.__n1Originals.has(m)) {
        m.fragmentShader = window.__n1Originals.get(m);
        m.needsUpdate = true;
      }
    });
    delete window.__n1Originals;
  });
  await twoFrames(page);
  shots.N1restored = await shoot(page, 'N1r-restored');
  results.N1restored = metrics(decodePNG(fs.readFileSync(shots.N1restored)));

  // N2: flat environment (constant radiance) via the real Environment card.
  const flatHdr = makeFlatHdr(0.5);
  await page.locator(ENVIRONMENT_INPUT).setInputFiles({ name: 'flat.hdr', mimeType: 'application/octet-stream', buffer: flatHdr });
  await page.waitForFunction(() => window.getEnvOverride && window.getEnvOverride(), null, { timeout: WAIT_TIMEOUT });
  await twoFrames(page);
  shots.N2 = await shoot(page, 'N2-flatenv');
  results.N2 = metrics(decodePNG(fs.readFileSync(shots.N2)));

  // Reset environment back to default via the sidebar Reset button.
  await page.getByTestId('usd-scene-sidebar').getByRole('button', { name: 'Reset' }).click();
  await twoFrames(page);
  const resetShot = await shoot(page, 'N2r-reset');
  results.N2restored = metrics(decodePNG(fs.readFileSync(resetShot)));

  // N3: lights off on every material.
  const n3Touched = await page.evaluate(() => {
    const dbg = window.__mtlxUsdSceneHandle.__debug();
    window.__n3Originals = new Map();
    let count = 0;
    dbg.materials.forEach((m) => {
      const u = m && m.uniforms && m.uniforms.u_numActiveLightSources;
      if (!u) return;
      window.__n3Originals.set(m, u.value);
      u.value = 0;
      count++;
    });
    return count;
  });
  await twoFrames(page);
  shots.N3 = await shoot(page, 'N3-lightsoff');
  results.N3 = metrics(decodePNG(fs.readFileSync(shots.N3)));

  // N4: flat env AND lights off together (N3 state still active).
  await page.locator(ENVIRONMENT_INPUT).setInputFiles({ name: 'flat.hdr', mimeType: 'application/octet-stream', buffer: flatHdr });
  await page.waitForFunction(() => window.getEnvOverride && window.getEnvOverride(), null, { timeout: WAIT_TIMEOUT });
  await twoFrames(page);
  shots.N4 = await shoot(page, 'N4-flatenv-lightsoff');
  results.N4 = metrics(decodePNG(fs.readFileSync(shots.N4)));

  // Restore lights and environment.
  await page.evaluate(() => {
    const dbg = window.__mtlxUsdSceneHandle.__debug();
    dbg.materials.forEach((m) => {
      if (window.__n3Originals && window.__n3Originals.has(m)) {
        m.uniforms.u_numActiveLightSources.value = window.__n3Originals.get(m);
      }
    });
    delete window.__n3Originals;
  });
  await page.getByTestId('usd-scene-sidebar').getByRole('button', { name: 'Reset' }).click();
  await twoFrames(page);

  // N5: chrome headlight close-up, device scale 1 then 2.
  const chromeInfo = await page.evaluate(() => {
    const dbg = window.__mtlxUsdSceneHandle.__debug();
    let best = null;
    dbg.scene.traverse((obj) => {
      if (!obj.isMesh || !obj.name) return;
      if (/headlight|chrome/i.test(obj.name)) {
        const box = new window.THREE.Box3().setFromObject(obj);
        const sphere = box.getBoundingSphere(new window.THREE.Sphere());
        if (!best || sphere.radius > best.radius) {
          best = { name: obj.name, center: [sphere.center.x, sphere.center.y, sphere.center.z], radius: sphere.radius };
        }
      }
    });
    return best;
  });
  notes.chromeInfo = chromeInfo;

  if (chromeInfo) {
    await page.evaluate((info) => {
      const handle = window.__mtlxUsdSceneHandle;
      const dist = info.radius * 3;
      const pos = [info.center[0], info.center[1], info.center[2] + dist];
      handle.setCamera({ position: pos, target: info.center });
    }, chromeInfo);
    await twoFrames(page);
    shots.N5a = await shoot(page, 'N5a-chrome-dpr1');
    results.N5a = metrics(decodePNG(fs.readFileSync(shots.N5a)));

    await page.evaluate(() => {
      const dbg = window.__mtlxUsdSceneHandle.__debug();
      dbg.renderer.setPixelRatio(2);
      window.dispatchEvent(new Event('resize'));
    });
    await twoFrames(page);
    shots.N5b = await shoot(page, 'N5b-chrome-dpr2');
    const n5bFull = decodePNG(fs.readFileSync(shots.N5b));
    const n5bDown = {
      width: Math.floor(n5bFull.width / 2),
      height: Math.floor(n5bFull.height / 2),
      getPixel: (x, y) => {
        const get = (xx, yy) => n5bFull.getPixel(Math.min(xx, n5bFull.width - 1), Math.min(yy, n5bFull.height - 1));
        const a = get(x * 2, y * 2), b = get(x * 2 + 1, y * 2), c = get(x * 2, y * 2 + 1), d = get(x * 2 + 1, y * 2 + 1);
        return { r: (a.r + b.r + c.r + d.r) / 4, g: (a.g + b.g + c.g + d.g) / 4, b: (a.b + b.b + c.b + d.b) / 4, a: 255 };
      },
    };
    results.N5b = metrics(n5bDown);
    await page.evaluate(() => { window.__mtlxUsdSceneHandle.__debug().renderer.setPixelRatio(1); window.dispatchEvent(new Event('resize')); });
  } else {
    notes.chromeInfo = 'no mesh matched /headlight|chrome/i';
  }

  const rowKeys = ['N0', 'N1', 'N1restored', 'N2', 'N2restored', 'N3', 'N4', 'N5a', 'N5b'];
  const rows = rowKeys.filter((k) => results[k]).map((k) => {
    const r = results[k];
    return `| ${k} | ${r.mean.toFixed(2)} | ${r.p95.toFixed(2)} | ${(r.frac230 * 100).toFixed(3)}% | ${(r.sparkleFrac * 100).toFixed(3)}% |`;
  });

  const n2Removes = results.N2.sparkleFrac < results.N0.sparkleFrac * 0.5;
  const n3Removes = results.N3.sparkleFrac < results.N0.sparkleFrac * 0.5;
  const n4Removes = results.N4.sparkleFrac < results.N0.sparkleFrac * 0.5;
  const n1Noisy = results.N1.sparkleFrac > 0.001 || results.N1.p95 - results.N1.mean > 60;

  let verdict;
  if (n1Noisy) {
    verdict = 'N1 normal-color visualization is itself speckled: the interpolated world normals are noisy (bad/degenerate vertex normals or tangent-space blending), independent of shading. Fix the normal source (recompute smooth normals or check for duplicated/zero-length normals in the authored mesh).';
  } else if (n2Removes || n4Removes) {
    verdict = 'A flat constant-radiance environment removes the sparkle (N2/N4): the speckle comes from environment sampling/mip selection against the real studio HDR, not from geometry or lights.';
  } else if (n3Removes) {
    verdict = 'Disabling analytic lights removes the sparkle (N3): the rig lights are the source (e.g. too many small, high-intensity point/spot lights aliasing on specular).';
  } else {
    verdict = 'Neither a flat environment (N2/N4) nor disabling lights (N3) removes the sparkle, and N1 shows smooth normals: the speckle is not sourced from normals, environment content, or analytic lights as isolated here. Re-examine anything not covered by N1-N5 (e.g. per-pixel shading math specific to the paint/glass BRDF, or an artifact introduced only when environment+lights are combined nonlinearly).';
  }

  const report = [
    '# Stirling sparkle isolation: normals vs environment vs lights',
    '',
    `Varying used for N1: ${notes.n1 && notes.n1.varyingUsed || '(none found)'}`,
    `N1 materials touched: ${notes.n1 && notes.n1.touchedCount} of ${notes.n1 && notes.n1.materialCount}`,
    `N1 compile errors: ${notes.n1CompileErrors && notes.n1CompileErrors.length ? notes.n1CompileErrors.join(' | ') : 'none'}`,
    `Chrome headlight mesh: ${chromeInfo ? chromeInfo.name : notes.chromeInfo}`,
    '',
    '## Metrics (central 50% box)',
    '',
    '| Capture | mean | p95 | frac>230 | sparkle proxy |',
    '|---|---|---|---|---|',
    ...rows,
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
