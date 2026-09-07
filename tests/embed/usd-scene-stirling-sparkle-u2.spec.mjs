import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

// Round B continuation: U1 texture audit plus U5/U6, all on untouched
// original materials (no mtlx edits), after U4 (all-materials edit) hung
// the app past its 180s render-status timeout in the first run.
const suppliedRoot = process.env.USD_STIRLING_ROOT || '';
const suppliedDir = path.dirname(path.dirname(suppliedRoot));
const outDir = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\ab8';

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

async function loadFramed(page, embedURL) {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await loadAsset(page, embedURL);
  await frameHoodCloseup(page);
  await twoFrames(page);
}

test('@scene U1/U5/U6 on original materials', async ({ page, embedURL }) => {
  test.skip(!suppliedRoot, 'Set USD_STIRLING_ROOT to run this bounded diagnosis.');
  test.setTimeout(600000);
  fs.mkdirSync(outDir, { recursive: true });
  const results = {};
  const shots = {};

  await loadFramed(page, embedURL);

  // U1: texture state audit, no edits.
  const auditRows = await page.evaluate(() => {
    const dbg = window.__mtlxUsdSceneHandle.__debug();
    const rows = [];
    dbg.materials.forEach((m, idx) => {
      const src = (m.fragmentShader || '') + (m.vertexShader || '');
      if (!src.includes('hextiledimage') && !src.includes('bump')) return;
      const uniforms = m.uniforms || {};
      Object.keys(uniforms).forEach((name) => {
        const u = uniforms[name];
        const v = u && u.value;
        const tex = v && v.isTexture ? v : null;
        if (!tex) return;
        const img = tex.image || {};
        let maxMip = 'n/a';
        try {
          const props = dbg.renderer.properties.get(tex);
          maxMip = props && props.__maxMipLevel !== undefined ? props.__maxMipLevel : 'n/a';
        } catch (e) { maxMip = 'error:' + e.message; }
        rows.push({
          materialIndex: idx,
          uniform: name,
          width: img.width || 'n/a',
          height: img.height || 'n/a',
          minFilter: tex.minFilter,
          magFilter: tex.magFilter,
          generateMipmaps: tex.generateMipmaps,
          anisotropy: tex.anisotropy,
          maxMipLevel: maxMip,
          mipmapsLength: (tex.mipmaps || []).length,
        });
      });
    });
    return rows;
  });
  const u1Audit = auditRows.length
    ? auditRows.map((r) => `| ${r.materialIndex} | ${r.uniform} | ${r.width}x${r.height} | ${r.minFilter} | ${r.magFilter} | ${r.generateMipmaps} | ${r.anisotropy} | ${r.maxMipLevel} | ${r.mipmapsLength} |`).join('\n')
    : '(no sampler uniforms found on hextiledimage/bump materials)';

  // U5: anisotropy 8 on every mipmapped sampler.
  await page.evaluate(() => {
    const dbg = window.__mtlxUsdSceneHandle.__debug();
    dbg.materials.forEach((m) => {
      const uniforms = m.uniforms || {};
      Object.keys(uniforms).forEach((name) => {
        const u = uniforms[name];
        const tex = u && u.value;
        if (tex && tex.isTexture && tex.generateMipmaps) {
          tex.anisotropy = 8;
          tex.needsUpdate = true;
        }
      });
    });
  });
  await twoFrames(page);
  shots.U5 = await shoot(page, 'U5-anisotropy8');
  results.U5 = metrics(decodePNG(fs.readFileSync(shots.U5)));

  // U6: reload fresh, 2x device pixel ratio.
  await loadFramed(page, embedURL);
  await page.evaluate(() => {
    const dbg = window.__mtlxUsdSceneHandle.__debug();
    dbg.renderer.setPixelRatio(2);
    window.dispatchEvent(new Event('resize'));
  });
  await twoFrames(page);
  shots.U6 = await shoot(page, 'U6-devicescale2x');
  const u6Full = decodePNG(fs.readFileSync(shots.U6));
  const u6Down = {
    width: Math.floor(u6Full.width / 2),
    height: Math.floor(u6Full.height / 2),
    getPixel: (x, y) => {
      const get = (xx, yy) => u6Full.getPixel(Math.min(xx, u6Full.width - 1), Math.min(yy, u6Full.height - 1));
      const a = get(x * 2, y * 2), b = get(x * 2 + 1, y * 2), c = get(x * 2, y * 2 + 1), d = get(x * 2 + 1, y * 2 + 1);
      return { r: (a.r + b.r + c.r + d.r) / 4, g: (a.g + b.g + c.g + d.g) / 4, b: (a.b + b.b + c.b + d.b) / 4, a: 255 };
    },
  };
  results.U6 = metrics(u6Down);

  const rows = Object.keys(results).map((k) => {
    const r = results[k];
    return `| ${k} | ${r.mean.toFixed(2)} | ${r.p95.toFixed(2)} | ${(r.frac230 * 100).toFixed(3)}% | ${(r.sparkleFrac * 100).toFixed(3)}% |`;
  });
  const report = [
    '## U1/U5/U6 metrics',
    '',
    '| Capture | mean | p95 | frac>230 | sparkle proxy |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    '## U1 texture state audit (hextiledimage/bump materials only)',
    '',
    '| material index | uniform | size | minFilter | magFilter | generateMipmaps | anisotropy | maxMipLevel | mipmaps.length |',
    '|---|---|---|---|---|---|---|---|---|',
    u1Audit,
    '',
    '## Screenshots',
    '',
    ...Object.entries(shots).map(([k, p]) => `- ${k}: ${p}`),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'REPORT-part2.md'), report, 'utf8');
  // eslint-disable-next-line no-console
  console.log(report);
});
