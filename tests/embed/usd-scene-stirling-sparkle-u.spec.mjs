import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

// Round B of the bounded Stirling sparkle diagnosis. Opt-in only; set
// USD_STIRLING_ROOT to the Real_Time usda root under the Temp asset copy.
const suppliedRoot = process.env.USD_STIRLING_ROOT || '';
const suppliedDir = path.dirname(path.dirname(suppliedRoot));
const matDir = suppliedRoot ? path.join(suppliedDir, 'materials', 'Real_Time') : '';
const outDir = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\ab8';
const goldenDir = 'C:\\Users\\joaov\\Downloads\\Stirling_MaterialX\\materials\\Real_Time';

const FILES = {
  paint: 'Car_Paint_MaterialX_Real_Time.mtlx',
  window: 'Window_MaterialX_Real_Time.mtlx',
  chrome: 'Chrome_MaterialX_Real_Time.mtlx',
  tires: 'Tires_Rubber_MaterialX_Real_Time.mtlx',
  undercarriage: 'Undercarriage_MaterialX_Real_Time.mtlx',
};

function filePath(key) {
  return path.join(matDir, FILES[key]);
}

function backup(key) {
  fs.copyFileSync(filePath(key), filePath(key) + '.orig');
}

function restore(key) {
  const orig = filePath(key) + '.orig';
  if (fs.existsSync(orig)) {
    fs.copyFileSync(orig, filePath(key));
    fs.unlinkSync(orig);
  }
}

function read(key) {
  return fs.readFileSync(filePath(key), 'utf8');
}

function write(key, content) {
  fs.writeFileSync(filePath(key), content, 'utf8');
}

// Removes every <input name="normal" ... nodename="mtlxbumpN" /> line (any
// count, any bump index), CRLF safe.
function bypassBumps(content) {
  return content.replace(/[ \t]*<input name="normal" type="vector3" nodename="mtlxbump\d*"\s*\/>\r?\n/g, '');
}

// Replaces every <hextiledimage ...>...</hextiledimage> element with a
// <constant> of the same name/type at value 0.5, so downstream nodename
// references keep resolving.
function bypassHextiles(content) {
  return content.replace(
    /<hextiledimage name="([^"]+)" type="([^"]+)"[^>]*>[\s\S]*?<\/hextiledimage>/g,
    (_m, name, type) => {
      const value = type === 'float' ? '0.5' : '0.5, 0.5, 0.5';
      return `<constant name="${name}" type="${type}"><input name="value" type="${type}" value="${value}" /></constant>`;
    },
  );
}

function bypassBumpsAndHextiles(content) {
  return bypassHextiles(bypassBumps(content));
}

function greenTint(content) {
  return content
    .replace('<input name="color" type="color3" value="0.0686, 0.1096, 0.1453" />', '<input name="color" type="color3" value="0, 1, 0" />');
}

function flakesZero(content) {
  return content
    .replace('<input name="coverage" type="float" value="0.8" />', '<input name="coverage" type="float" value="0" />')
    .replace('<input name="coverage" type="float" value="0.7" />', '<input name="coverage" type="float" value="0" />');
}

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

test('@scene diagnoses Stirling sparkle round B', async ({ page, embedURL }) => {
  test.skip(!suppliedRoot, 'Set USD_STIRLING_ROOT to run this bounded diagnosis.');
  test.setTimeout(1800000);
  fs.mkdirSync(outDir, { recursive: true });

  const keys = Object.keys(FILES);
  const originals = {};
  keys.forEach((k) => { originals[k] = read(k); });
  keys.forEach((k) => backup(k));

  const results = {};
  const shots = {};
  let u1Audit = '(not captured)';

  try {
    // U0: original.
    await loadFramed(page, embedURL);
    shots.U0 = await shoot(page, 'U0-original');
    results.U0 = metrics(decodePNG(fs.readFileSync(shots.U0)));

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
            width: img.width || tex.image?.width || 'n/a',
            height: img.height || tex.image?.height || 'n/a',
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
    u1Audit = auditRows.length
      ? auditRows.map((r) => `| ${r.materialIndex} | ${r.uniform} | ${r.width}x${r.height} | ${r.minFilter} | ${r.magFilter} | ${r.generateMipmaps} | ${r.anisotropy} | ${r.maxMipLevel} | ${r.mipmapsLength} |`).join('\n')
      : '(no sampler uniforms found on hextiledimage/bump materials)';

    // U2: paint. flakes 0, both bumps bypassed, sand hextiles to grey, green tint.
    let content = originals.paint;
    content = flakesZero(content);
    content = greenTint(content);
    content = bypassBumpsAndHextiles(content);
    write('paint', content);
    if (/nodename="mtlxbump/.test(read('paint'))) {
      throw new Error('U2: mtlxbump reference still present after bypass');
    }
    await loadFramed(page, embedURL);
    shots.U2 = await shoot(page, 'U2-paint-clean');
    results.U2 = metrics(decodePNG(fs.readFileSync(shots.U2)));
    restore('paint');
    backup('paint');

    // U3: window. bypass bump + hextile.
    content = bypassBumpsAndHextiles(originals.window);
    write('window', content);
    await loadFramed(page, embedURL);
    shots.U3 = await shoot(page, 'U3-window-clean');
    results.U3 = metrics(decodePNG(fs.readFileSync(shots.U3)));
    restore('window');
    backup('window');

    // U4: everything. paint + window + chrome + tires + undercarriage, all
    // bumps bypassed and all hextiledimage nodes replaced by constants.
    write('paint', bypassBumpsAndHextiles(greenTint(flakesZero(originals.paint))));
    write('window', bypassBumpsAndHextiles(originals.window));
    write('chrome', bypassBumpsAndHextiles(originals.chrome));
    write('tires', bypassBumpsAndHextiles(originals.tires));
    write('undercarriage', bypassBumpsAndHextiles(originals.undercarriage));
    await loadFramed(page, embedURL);
    shots.U4 = await shoot(page, 'U4-everything-clean');
    results.U4 = metrics(decodePNG(fs.readFileSync(shots.U4)));

    // If speckle remains, crop a 300x300 region at 2x device scale.
    await page.evaluate(() => {
      const dbg = window.__mtlxUsdSceneHandle.__debug();
      dbg.renderer.setPixelRatio(2);
      window.dispatchEvent(new Event('resize'));
    });
    await twoFrames(page);
    const canvas = page.getByTestId('usd-scene-canvas').locator('canvas');
    const box = await canvas.boundingBox();
    if (box) {
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      await page.screenshot({
        path: path.join(outDir, 'U4-crop-300x300@2x.png'),
        clip: { x: cx - 150, y: cy - 150, width: 300, height: 300 },
      });
    }
    await page.evaluate(() => {
      const dbg = window.__mtlxUsdSceneHandle.__debug();
      dbg.renderer.setPixelRatio(1);
      window.dispatchEvent(new Event('resize'));
    });

    keys.forEach((k) => { restore(k); backup(k); });

    // U5: original materials, anisotropy 8 on every mipmapped sampler.
    await loadFramed(page, embedURL);
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

    // U6: original materials, 2x device pixel ratio (repeats T5 on U0 framing).
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
    await page.evaluate(() => {
      const dbg = window.__mtlxUsdSceneHandle.__debug();
      dbg.renderer.setPixelRatio(1);
      window.dispatchEvent(new Event('resize'));
    });

    const rows = Object.keys(results).map((k) => {
      const r = results[k];
      return `| ${k} | ${r.mean.toFixed(2)} | ${r.p95.toFixed(2)} | ${(r.frac230 * 100).toFixed(3)}% | ${(r.sparkleFrac * 100).toFixed(3)}% |`;
    });
    const report = [
      '# Stirling sparkle diagnosis round B',
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
    fs.writeFileSync(path.join(outDir, 'REPORT.md'), report, 'utf8');

    // eslint-disable-next-line no-console
    console.log(report);
  } finally {
    keys.forEach((k) => { restore(k); write(k, originals[k]); });
  }
});
