import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

// Opt-in bounded diagnosis of the Stirling car paint sparkle. Never enabled
// in CI; set USD_STIRLING_ROOT to the Real_Time usda root to run it.
const suppliedRoot = process.env.USD_STIRLING_ROOT || '';
const suppliedDir = path.dirname(path.dirname(suppliedRoot)); // .../usd/<root>.usda -> asset folder
const mtlxPath = suppliedRoot
  ? path.join(suppliedDir, 'materials', 'Real_Time', 'Car_Paint_MaterialX_Real_Time.mtlx')
  : '';
const outDir = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\ab6';

let originalMtlx = '';

function writeMtlx(content) {
  fs.writeFileSync(mtlxPath, content, 'utf8');
}

// Central 50% box metrics plus a sparkle proxy: fraction of pixels whose
// luminance exceeds the 3x3 box-mean of their neighbourhood by >40 levels.
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
  return {
    mean: sum / count,
    p95,
    frac230: above230 / count,
    sparkleFrac: sparkle / count,
  };
}

// Box-downsamples a decoded PNG by 2x for the T5 supersampling comparison.
function downsample2x(image) {
  const w = Math.floor(image.width / 2), h = Math.floor(image.height / 2);
  const get = (x, y) => image.getPixel(Math.min(x, image.width - 1), Math.min(y, image.height - 1));
  return {
    width: w,
    height: h,
    getPixel: (x, y) => {
      const sx = x * 2, sy = y * 2;
      const a = get(sx, sy), b = get(sx + 1, sy), c = get(sx, sy + 1), d = get(sx + 1, sy + 1);
      return {
        r: (a.r + b.r + c.r + d.r) / 4,
        g: (a.g + b.g + c.g + d.g) / 4,
        b: (a.b + b.b + c.b + d.b) / 4,
        a: 255,
      };
    },
  };
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

// Moves the camera 60% of the way from its current position toward its
// current target: a hood close-up without needing scene-specific bounds.
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

test('@scene diagnoses Stirling car paint sparkle', async ({ page, embedURL }) => {
  test.skip(!suppliedRoot, 'Set USD_STIRLING_ROOT to run this bounded diagnosis.');
  test.setTimeout(900000);
  fs.mkdirSync(outDir, { recursive: true });
  originalMtlx = fs.readFileSync(mtlxPath, 'utf8');
  const results = {};
  const shots = {};

  try {
    // T0: original.
    await page.setViewportSize({ width: 1600, height: 1200 });
    await loadAsset(page, embedURL);
    await frameHoodCloseup(page);
    await twoFrames(page);
    shots.T0 = await shoot(page, 'T0-original');
    results.T0 = metrics(decodePNG(fs.readFileSync(shots.T0)));

    // Uniform name list of the paint material (found by fragment source).
    const uniformNames = await page.evaluate(() => {
      const dbg = window.__mtlxUsdSceneHandle.__debug();
      const paintMat = dbg.materials.find((m) => {
        const src = (m.fragmentShader || '') + (m.vertexShader || '');
        return src.includes('flake3d') || src.includes('mtlxflake3d1');
      });
      if (!paintMat) return null;
      return Object.keys(paintMat.uniforms || {});
    });

    // T1: env sample counts, in place on the live material set.
    for (const n of [128, 512]) {
      await page.evaluate((samples) => {
        const dbg = window.__mtlxUsdSceneHandle.__debug();
        dbg.materials.forEach((m) => {
          if (m.uniforms && m.uniforms.u_envRadianceSamples) m.uniforms.u_envRadianceSamples.value = samples;
        });
      }, n);
      await twoFrames(page);
      const key = 'T1-env' + n;
      shots[key] = await shoot(page, key);
      results[key] = metrics(decodePNG(fs.readFileSync(shots[key])));
    }
    await page.evaluate(() => {
      const dbg = window.__mtlxUsdSceneHandle.__debug();
      dbg.materials.forEach((m) => {
        if (m.uniforms && m.uniforms.u_envRadianceSamples) m.uniforms.u_envRadianceSamples.value = 16;
      });
    });

    // T2: flakes at coverage 0, plus an unmistakable color change on the
    // paint branch's diffuse base, to prove the edit round-trips live.
    let content = originalMtlx
      .replace('<input name="coverage" type="float" value="0.8" />', '<input name="coverage" type="float" value="0" />')
      .replace('<input name="coverage" type="float" value="0.7" />', '<input name="coverage" type="float" value="0" />')
      .replace('<input name="color" type="color3" value="0.0686, 0.1096, 0.1453" />', '<input name="color" type="color3" value="0, 1, 0" />');
    writeMtlx(content);
    await loadAsset(page, embedURL);
    await frameHoodCloseup(page);
    await twoFrames(page);
    shots.T2 = await shoot(page, 'T2-flakes0-green');
    results.T2 = metrics(decodePNG(fs.readFileSync(shots.T2)));

    // T3: flakes at coverage 0, color unchanged.
    content = originalMtlx
      .replace('<input name="coverage" type="float" value="0.8" />', '<input name="coverage" type="float" value="0" />')
      .replace('<input name="coverage" type="float" value="0.7" />', '<input name="coverage" type="float" value="0" />');
    writeMtlx(content);
    await loadAsset(page, embedURL);
    await frameHoodCloseup(page);
    await twoFrames(page);
    shots.T3 = await shoot(page, 'T3-flakes0');
    results.T3 = metrics(decodePNG(fs.readFileSync(shots.T3)));

    // T4: bumps bypassed only, flakes untouched. The source file is CRLF,
    // so drop the whole line (with its line ending) via regex, not a
    // literal \n that would never match \r\n.
    content = originalMtlx
      .replace(/[ \t]*<input name="normal" type="vector3" nodename="mtlxbump1" \/>\r?\n/, '')
      .replace(/[ \t]*<input name="normal" type="vector3" nodename="mtlxbump2" \/>\r?\n/g, '');
    writeMtlx(content);
    await loadAsset(page, embedURL);
    await frameHoodCloseup(page);
    await twoFrames(page);
    shots.T4 = await shoot(page, 'T4-nobump');
    results.T4 = metrics(decodePNG(fs.readFileSync(shots.T4)));

    // T5: original material, 2x device scale factor / pixel ratio.
    writeMtlx(originalMtlx);
    await loadAsset(page, embedURL);
    await frameHoodCloseup(page);
    await page.evaluate(() => {
      const dbg = window.__mtlxUsdSceneHandle.__debug();
      dbg.renderer.setPixelRatio(2);
      window.dispatchEvent(new Event('resize'));
    });
    await twoFrames(page);
    shots.T5 = await shoot(page, 'T5-supersample2x');
    const t5Full = decodePNG(fs.readFileSync(shots.T5));
    const t5Down = downsample2x(t5Full);
    results.T5 = metrics(t5Down);
    await page.evaluate(() => {
      const dbg = window.__mtlxUsdSceneHandle.__debug();
      dbg.renderer.setPixelRatio(1);
      window.dispatchEvent(new Event('resize'));
    });

    // T6: original material, conductor roughness forced up.
    await twoFrames(page);
    const roughnessUniforms = await page.evaluate(() => {
      const dbg = window.__mtlxUsdSceneHandle.__debug();
      const paintMat = dbg.materials.find((m) => {
        const src = (m.fragmentShader || '') + (m.vertexShader || '');
        return src.includes('flake3d') || src.includes('mtlxflake3d1');
      });
      if (!paintMat) return [];
      const names = Object.keys(paintMat.uniforms || {}).filter((k) => k.toLowerCase().includes('roughness'));
      names.forEach((n) => {
        const u = paintMat.uniforms[n];
        if (typeof u.value === 'number') u.value = 0.5;
        else if (u.value && typeof u.value.x === 'number') { u.value.x = 0.5; u.value.y = 0.5; }
      });
      return names;
    });
    await twoFrames(page);
    shots.T6 = await shoot(page, 'T6-roughness0.5');
    results.T6 = metrics(decodePNG(fs.readFileSync(shots.T6)));

    // Report.
    const rows = Object.keys(results).map((k) => {
      const r = results[k];
      return `| ${k} | ${r.mean.toFixed(2)} | ${r.p95.toFixed(2)} | ${(r.frac230 * 100).toFixed(3)}% | ${(r.sparkleFrac * 100).toFixed(3)}% |`;
    });
    const report = [
      '# Stirling car paint sparkle diagnosis',
      '',
      '| Capture | mean | p95 | frac>230 | sparkle proxy |',
      '|---|---|---|---|---|',
      ...rows,
      '',
      '## Paint material uniform names',
      '',
      uniformNames ? uniformNames.join(', ') : '(paint material not found by fragment source match)',
      '',
      '## Roughness uniforms adjusted for T6',
      '',
      roughnessUniforms.join(', ') || '(none found)',
      '',
      '## Screenshots',
      '',
      ...Object.entries(shots).map(([k, p]) => `- ${k}: ${p}`),
    ].join('\n');
    fs.writeFileSync(path.join(outDir, 'REPORT.md'), report, 'utf8');

    // eslint-disable-next-line no-console
    console.log(report);
  } finally {
    if (originalMtlx) writeMtlx(originalMtlx);
  }
});
