// tests/embed/usd-scene-playground-speckle.spec.mjs: opt-in headed
// diagnosis of the skirting-board grain on materials/iceCube.mtlx (bound to
// /World/wallsFloor_grp/floorBoards_grp/pPlane4, pPlane5, pPlane14) on the
// OpenPBR Shader Playground stage. Leading hypothesis: mx_heighttonormal at
// scale 1.0 over a 4096 grunge texture yields near-horizontal per-pixel
// normals (the Stirling car-paint bump mechanism). Set USD_PLAYGROUND_ROOT
// to the ShdrPlygrnd_OpenPBR.usda path in place to run; skipped otherwise.
// Run headed: `npx playwright test usd-scene-playground-speckle --headed
// --workers=1`. Captures and REPORT.md land in Temp\mxpt-renders\round6.
//
// Fixed configuration: deviceScaleFactor 2 (canvas 3976x2532), sidebar
// collapsed, DEFAULT auto-framing camera (applyCamera is never called).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

// Minimal, dependency-free RGBA PNG encoder (single zlib-deflated IDAT), used
// only to save a 3x TRIM confirmation crop; tests/embed/lib/png.mjs only
// decodes.
function encodePNG(rgba, width, height) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const suppliedRoot = process.env.USD_PLAYGROUND_ROOT || '';
const suppliedDir = suppliedRoot ? path.dirname(suppliedRoot) : '';
const OUT_DIR = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\round6';
const STAGE_WAIT_CAP_MS = 480000;
const POLL_INTERVAL_MS = 15000;
const VIEWPORT = { width: 1988, height: 1266 };
const DSF = 2; // canvas is therefore 3976 x 2532

// TRIM: fixed pixel band on the skirting board (materials/iceCube.mtlx,
// bound on pPlane4/pPlane5/pPlane14), visually confirmed at this dsf.
const TRIM_BOX = { x: 3400, y: 2364, w: 500, h: 18 };

function log(...args) {
  console.log('[playground-speckle]', new Date().toISOString(), ...args);
}

let results = {
  uniformNames: null, pokeNotes: [], metricsTable: [], normalStats: [],
  diffChecks: [], captions: [],
};

// Cross-process persistence: each foreground `npx playwright test -g ...`
// call is its own process, and this series runs across several such calls
// (headed GPU renders of a 321-file, 2.9M-triangle stage take minutes
// each). State merges into a JSON file beside REPORT.md.
const STATE_PATH = path.join(OUT_DIR, 'state.json');
function loadState() {
  try { results = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')).results ?? results; } catch (e) { /* first run */ }
}
function saveState() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({ results }, null, 2), 'utf8');
}

// Luminance-space metrics over a pixel box: mean, p95, and grainFrac (the
// fraction of pixels exceeding their 3x3 neighbourhood mean by more than
// `threshold` levels).
function metrics(image, box, threshold) {
  const x0 = box.x, x1 = Math.min(box.x + box.w, image.width);
  const y0 = box.y, y1 = Math.min(box.y + box.h, image.height);
  const lum = (x, y) => { const p = image.getPixel(x, y); return 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b; };
  let sum = 0, count = 0, grain = 0;
  const values = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const l = lum(x, y);
      values.push(l); sum += l; count++;
      if (x > x0 && x < x1 - 1 && y > y0 && y < y1 - 1) {
        let nsum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) nsum += lum(x + dx, y + dy);
        if (l - nsum / 9 > threshold) grain++;
      }
    }
  }
  values.sort((a, b) => a - b);
  const p95 = values.length ? values[Math.floor(values.length * 0.95)] : null;
  return { mean: count ? sum / count : null, p95, grainFrac: count ? grain / count : null, count };
}

function wholeCanvasMeanAbsDiff(before, after) {
  const w = Math.min(before.width, after.width), h = Math.min(before.height, after.height);
  let sum = 0, count = 0;
  const step = 4;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const a = before.getPixel(x, y), b = after.getPixel(x, y);
      sum += Math.abs((0.2126 * a.r + 0.7152 * a.g + 0.0722 * a.b) - (0.2126 * b.r + 0.7152 * b.g + 0.0722 * b.b));
      count++;
    }
  }
  return count ? sum / count : 0;
}

async function save3xCrop(image, box, outPath) {
  const scale = 3;
  const w = box.w * scale, h = box.h * scale;
  const pixels = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = image.getPixel(box.x + Math.floor(x / scale), box.y + Math.floor(y / scale));
      const i = (y * w + x) * 4;
      pixels[i] = p.r; pixels[i + 1] = p.g; pixels[i + 2] = p.b; pixels[i + 3] = 255;
    }
  }
  fs.writeFileSync(outPath, encodePNG(pixels, w, h));
}

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

// Loads the Playground stage with Texture resolution 2048 / memory 4 GB,
// collapses the sidebar, and leaves the DEFAULT auto-framing camera in
// place - applyCamera is never called.
async function loadStageDefaultCamera(page, embedURL) {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();

  const resCombo = page.locator('text=Texture resolution').locator('..').getByRole('combobox');
  if (await resCombo.count()) {
    const label = await resCombo.textContent().catch(() => '');
    if (!/2048/.test(label || '')) { await resCombo.click(); await page.getByRole('option', { name: '2048 px', exact: true }).click(); }
  }
  const memCombo = page.locator('text=Texture memory').locator('..').getByRole('combobox');
  if (await memCombo.count()) {
    const label = await memCombo.textContent().catch(() => '');
    if (!/4 GB/.test(label || '')) { await memCombo.click(); await page.getByRole('option', { name: '4 GB', exact: true }).click(); }
  }

  log('uploading folder ...', suppliedDir);
  await page.locator('input[type=file][webkitdirectory]').setInputFiles(suppliedDir);

  const rootSelectWrap = page.getByTestId('usd-scene-root-select');
  try {
    await expect(rootSelectWrap).toBeVisible({ timeout: 30000 });
    const rootCombobox = rootSelectWrap.getByRole('combobox');
    if (await rootCombobox.count()) {
      await rootCombobox.click();
      const options = await page.getByRole('option').allTextContents();
      const rootBasename = path.basename(suppliedRoot);
      const rootPicked = options.find((label) => label.endsWith('/' + rootBasename) || label === rootBasename);
      if (rootPicked) await page.getByRole('option', { name: rootPicked, exact: true }).click();
    }
  } catch (e) { log('root select did not appear:', String(e && e.message || e)); }

  await page.getByTestId('usd-scene-sidebar').getByRole('button', { name: /^Load (?!example)/ }).click();
  const result = await pollStageStatus(page, STAGE_WAIT_CAP_MS);
  log('poll finished', JSON.stringify(result));
  if (!result.rendered) throw new Error('stage did not reach rendered: ' + JSON.stringify(result));

  await page.waitForFunction(() => window.__mtlxUsdSceneHandle && typeof window.__mtlxUsdSceneHandle.__debug === 'function', null, { timeout: 30000 });

  const collapseBtn = page.getByTitle('Collapse the scene viewer panel');
  if (await collapseBtn.count()) await collapseBtn.click();
  await page.waitForTimeout(300);

  await page.evaluate(() => window.__mtlxUsdSceneHandle.renderNow());
}

async function captureFull(page, name) {
  const filePath = path.join(OUT_DIR, name);
  await page.screenshot({ path: filePath });
  return filePath;
}

async function openConditionPage(browser) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DSF });
  const page = await context.newPage();
  return { context, page };
}

// Dumps every uniform name on the iceCube material, plus a best-effort
// classification (isTexture, image src if any) to help match by hand.
async function dumpIceCubeUniforms(page) {
  return page.evaluate(() => {
    const dbg = window.__mtlxUsdSceneHandle.__debug();
    const mat = dbg.materials.find((m) => (m.userData && m.userData.mtlxSceneSourceAsset || '').endsWith('iceCube.mtlx'));
    if (!mat || !mat.uniforms) return null;
    const out = {};
    for (const key of Object.keys(mat.uniforms)) {
      const v = mat.uniforms[key].value;
      if (v && v.isTexture) out[key] = { isTexture: true, src: (v.image && (v.image.src || v.image.currentSrc)) || null };
      else out[key] = { isTexture: false, value: (v && typeof v === 'object' && 'x' in v) ? [v.x, v.y, v.z] : v };
    }
    return out;
  });
}

test.describe('@scene opt-in: Playground iceCube skirting grain diagnosis', () => {
  test.beforeAll(() => { fs.mkdirSync(OUT_DIR, { recursive: true }); loadState(); });
  test.afterEach(() => saveState());

  test.afterAll(() => {
    function fmt(v) { return (v === null || v === undefined || Number.isNaN(v)) ? 'n/a' : (typeof v === 'number' ? v.toFixed(4) : String(v)); }
    const lines = [];
    lines.push('# Playground iceCube skirting grain diagnosis (Round 6, WP-S1, revision 4)');
    lines.push('');
    lines.push('Fixed configuration: deviceScaleFactor 2 (canvas 3976x2532), sidebar');
    lines.push('collapsed, DEFAULT auto-framing camera (applyCamera never called).');
    lines.push('');
    lines.push('Target: materials/iceCube.mtlx, bound to');
    lines.push('/World/wallsFloor_grp/floorBoards_grp/pPlane4 (back wall skirting, TRIM');
    lines.push('box below), plus pPlane5 and pPlane14 on the side walls. Node graph:');
    lines.push('Roughness image (iceCube_rougness.tif) -> specular_roughness;');
    lines.push('Bump image (iceCube_grunge1.tif) -> heighttonormal(scale default 1.0) ->');
    lines.push('normalmap -> geometry_normal; specular_roughness_anisotropy = 0.5.');
    lines.push('');
    lines.push('## Region');
    lines.push('- TRIM: ' + JSON.stringify(TRIM_BOX));
    lines.push('');
    lines.push('## iceCube material uniform names');
    lines.push('```json');
    lines.push(JSON.stringify(results.uniformNames, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('## Poke notes (which uniform each H-step actually matched)');
    for (const n of results.pokeNotes) lines.push('- ' + n);
    lines.push('');
    lines.push('## Metrics table (mean, p95, grainFrac at 6-level threshold, TRIM only)');
    lines.push('');
    lines.push('| Condition | mean | p95 | grainFrac(6) |');
    lines.push('|---|---|---|---|');
    for (const row of results.metricsTable) lines.push('| ' + row.condition + ' | ' + fmt(row.mean) + ' | ' + fmt(row.p95) + ' | ' + fmt(row.grainFrac) + ' |');
    lines.push('');
    lines.push('## Poke-applied checks (whole-canvas mean abs luminance diff vs H1)');
    lines.push('');
    lines.push('| Condition | meanAbsDiff | applied (>0.05)? |');
    lines.push('|---|---|---|');
    for (const row of results.diffChecks) lines.push('| ' + row.condition + ' | ' + fmt(row.diff) + ' | ' + (row.diff > 0.05 ? 'yes' : 'NO') + ' |');
    lines.push('');
    lines.push('## N2: per-triangle face-normal vs vertex-normal angle statistics');
    lines.push('');
    lines.push('| Mesh | meshCount | triCount | vertCount | meanAngle(deg) | p95Angle(deg) | fracTrisOver2deg |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const row of results.normalStats) lines.push('| ' + row.label + ' | ' + fmt(row.meshCount) + ' | ' + fmt(row.triCount) + ' | ' + fmt(row.vertCount) + ' | ' + fmt(row.meanAngleDeg) + ' | ' + fmt(row.p95AngleDeg) + ' | ' + fmt(row.fracTrianglesOver2deg) + ' |');
    lines.push('');
    lines.push('## Captures');
    for (const c of results.captions) lines.push('- ' + c.file + ': ' + c.caption);
    lines.push('');
    lines.push('## Verdict');
    lines.push('(filled in after H1-H5 land: whichever poke collapses TRIM grainFrac(6)');
    lines.push('toward zero identifies the cause - H2 flat bump implicates heighttonormal');
    lines.push('itself, H3 a low scale implicates the scale/texture-variance product, H4');
    lines.push('anisotropy and H5 roughness are controls for the other two node inputs.)');
    lines.push('');
    fs.writeFileSync(path.join(OUT_DIR, 'REPORT.md'), lines.join('\n'), 'utf8');
    log('wrote REPORT.md');
  });

  test('@scene opt-in: H1 baseline + uniform dump', async ({ browser, embedURL }) => {
    test.skip(!suppliedRoot, 'Set USD_PLAYGROUND_ROOT to run this opt-in pass.');
    test.setTimeout(590000);
    const { context, page } = await openConditionPage(browser);
    try {
      await loadStageDefaultCamera(page, embedURL);
      results.uniformNames = await dumpIceCubeUniforms(page);
      log('iceCube uniforms', JSON.stringify(results.uniformNames));

      const shot = 'h1-baseline.png';
      await captureFull(page, shot);
      fs.copyFileSync(path.join(OUT_DIR, shot), path.join(OUT_DIR, 'h1-baseline-ref.png'));
      const image = decodePNG(fs.readFileSync(path.join(OUT_DIR, shot)));
      const m = metrics(image, TRIM_BOX, 6);
      results.metricsTable.push({ condition: 'h1-baseline', mean: m.mean, p95: m.p95, grainFrac: m.grainFrac });
      results.captions.push({ file: shot, caption: 'H1 baseline, dsf 2, sidebar collapsed, default auto-framing camera.' });
      await save3xCrop(image, TRIM_BOX, path.join(OUT_DIR, 'h1-trim-crop-3x.png'));
      results.captions.push({ file: 'h1-trim-crop-3x.png', caption: '3x crop of the TRIM box (skirting board, iceCube.mtlx) for visual confirmation.' });
    } finally {
      await context.close();
    }
  });

  const H_STEPS = [
    {
      id: 'h2-flat-bump', caption: 'H2: Bump texture uniform replaced with a flat 128,128,128 1x1 texture.',
      mutate: () => {
        const dbg = window.__mtlxUsdSceneHandle.__debug();
        const mat = dbg.materials.find((m) => (m.userData && m.userData.mtlxSceneSourceAsset || '').endsWith('iceCube.mtlx'));
        if (!mat) return 'iceCube material not found';
        const keys = Object.keys(mat.uniforms);
        const key = keys.find((k) => /bump/i.test(k) && mat.uniforms[k].value && mat.uniforms[k].value.isTexture)
          || keys.find((k) => { const v = mat.uniforms[k].value; return v && v.isTexture && v.image && /grunge/i.test(String(v.image.src || v.image.currentSrc || '')); });
        if (!key) return 'no Bump texture uniform found among: ' + keys.join(', ');
        const flat = new window.THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, window.THREE.RGBAFormat);
        flat.needsUpdate = true;
        mat.uniforms[key].value = flat;
        window.__mtlxUsdSceneHandle.renderNow();
        return 'matched uniform: ' + key;
      },
    },
    {
      id: 'h3-heighttonormal-scale-005', caption: 'H3: heighttonormal scale uniform set to 0.05.',
      mutate: () => {
        const dbg = window.__mtlxUsdSceneHandle.__debug();
        const mat = dbg.materials.find((m) => (m.userData && m.userData.mtlxSceneSourceAsset || '').endsWith('iceCube.mtlx'));
        if (!mat) return 'iceCube material not found';
        const keys = Object.keys(mat.uniforms);
        const key = keys.find((k) => /height/i.test(k) && /scale/i.test(k)) || keys.find((k) => /height_to_norm/i.test(k));
        if (!key) return 'no height_to_norm scale uniform found among: ' + keys.join(', ');
        mat.uniforms[key].value = 0.05;
        window.__mtlxUsdSceneHandle.renderNow();
        return 'matched uniform: ' + key;
      },
    },
    {
      id: 'h4-anisotropy-0', caption: 'H4: specular_roughness_anisotropy uniform set to 0.',
      mutate: () => {
        const dbg = window.__mtlxUsdSceneHandle.__debug();
        const mat = dbg.materials.find((m) => (m.userData && m.userData.mtlxSceneSourceAsset || '').endsWith('iceCube.mtlx'));
        if (!mat) return 'iceCube material not found';
        const keys = Object.keys(mat.uniforms);
        const key = keys.find((k) => /anisotropy/i.test(k));
        if (!key) return 'no anisotropy uniform found among: ' + keys.join(', ');
        mat.uniforms[key].value = 0;
        window.__mtlxUsdSceneHandle.renderNow();
        return 'matched uniform: ' + key;
      },
    },
    {
      id: 'h5-flat-roughness', caption: 'H5: Roughness texture uniform replaced with a flat 100,100,100 1x1 texture.',
      mutate: () => {
        const dbg = window.__mtlxUsdSceneHandle.__debug();
        const mat = dbg.materials.find((m) => (m.userData && m.userData.mtlxSceneSourceAsset || '').endsWith('iceCube.mtlx'));
        if (!mat) return 'iceCube material not found';
        const keys = Object.keys(mat.uniforms);
        const key = keys.find((k) => /rough/i.test(k) && !/anisotropy/i.test(k) && mat.uniforms[k].value && mat.uniforms[k].value.isTexture);
        if (!key) return 'no Roughness texture uniform found among: ' + keys.join(', ');
        const flat = new window.THREE.DataTexture(new Uint8Array([100, 100, 100, 255]), 1, 1, window.THREE.RGBAFormat);
        flat.needsUpdate = true;
        mat.uniforms[key].value = flat;
        window.__mtlxUsdSceneHandle.renderNow();
        return 'matched uniform: ' + key;
      },
    },
  ];

  for (const step of H_STEPS) {
    test('@scene opt-in: ' + step.id, async ({ browser, embedURL }) => {
      test.skip(!suppliedRoot, 'Set USD_PLAYGROUND_ROOT to run this opt-in pass.');
      test.setTimeout(590000);
      const { context, page } = await openConditionPage(browser);
      try {
        await loadStageDefaultCamera(page, embedURL);
        const note = await page.evaluate(step.mutate);
        results.pokeNotes.push(step.id + ': ' + note);
        log(step.id, note);

        const shot = step.id + '.png';
        await captureFull(page, shot);
        results.captions.push({ file: shot, caption: step.caption });

        const baselinePath = path.join(OUT_DIR, 'h1-baseline-ref.png');
        if (fs.existsSync(baselinePath)) {
          const before = decodePNG(fs.readFileSync(baselinePath));
          const after = decodePNG(fs.readFileSync(path.join(OUT_DIR, shot)));
          results.diffChecks.push({ condition: step.id, diff: wholeCanvasMeanAbsDiff(before, after) });
        }
        const image = decodePNG(fs.readFileSync(path.join(OUT_DIR, shot)));
        const m = metrics(image, TRIM_BOX, 6);
        results.metricsTable.push({ condition: step.id, mean: m.mean, p95: m.p95, grainFrac: m.grainFrac });
      } finally {
        await context.close();
      }
    });
  }

  test('@scene opt-in: N2 normal-angle statistics (cardboardSeat1, wingLft, pPlane4)', async ({ browser, embedURL }) => {
    test.skip(!suppliedRoot, 'Set USD_PLAYGROUND_ROOT to run this opt-in pass.');
    test.setTimeout(590000);
    const { context, page } = await openConditionPage(browser);
    try {
      await loadStageDefaultCamera(page, embedURL);
      const specs = [
        { label: 'cardboardSeat1_geo', needle: 'cardboardseat1' },
        { label: 'wingLft_geo', needle: 'wing' },
        { label: 'pPlane4', needle: 'pplane4' },
      ];
      for (const spec of specs) {
        const stat = await page.evaluate((needle) => {
          const dbg = window.__mtlxUsdSceneHandle.__debug();
          const meshes = [];
          dbg.scene.traverse((o) => { if (o.isMesh && o.geometry && o.userData && (o.userData.primPath || '').toLowerCase().includes(needle)) meshes.push(o); });
          if (!meshes.length) return { meshCount: 0 };
          let triCount = 0, vertCount = 0, flagged = 0;
          const angles = [];
          for (const mesh of meshes) {
            const g = mesh.geometry;
            const pos = g.getAttribute('position');
            const nor = g.getAttribute('normal') || g.getAttribute('i_normal');
            if (!pos || !nor) continue;
            vertCount += pos.count;
            const idx = g.index;
            const tris = idx ? idx.count / 3 : pos.count / 3;
            const getIdx = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
            const norm3 = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
            const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
            const angDeg = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180 / Math.PI;
            for (let t = 0; t < tris; t++) {
              const ia = getIdx(t, 0), ib = getIdx(t, 1), ic = getIdx(t, 2);
              const pa = [pos.getX(ia), pos.getY(ia), pos.getZ(ia)];
              const pb = [pos.getX(ib), pos.getY(ib), pos.getZ(ib)];
              const pc = [pos.getX(ic), pos.getY(ic), pos.getZ(ic)];
              const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
              const e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
              const fn = norm3(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
              const vn = [ia, ib, ic].map((vi) => norm3(nor.getX(vi), nor.getY(vi), nor.getZ(vi)));
              angles.push(angDeg(fn, vn[0]), angDeg(fn, vn[1]), angDeg(fn, vn[2]));
              const pairMax = Math.max(angDeg(vn[0], vn[1]), angDeg(vn[0], vn[2]), angDeg(vn[1], vn[2]));
              if (pairMax > 2) flagged++;
              triCount++;
            }
          }
          angles.sort((a, b) => a - b);
          const mean = angles.length ? angles.reduce((s, v) => s + v, 0) / angles.length : null;
          const p95 = angles.length ? angles[Math.floor(angles.length * 0.95)] : null;
          return { meshCount: meshes.length, triCount, vertCount, meanAngleDeg: mean, p95AngleDeg: p95, fracTrianglesOver2deg: triCount ? flagged / triCount : null };
        }, spec.needle);
        results.normalStats.push({ label: spec.label, ...stat });
        log('N2', spec.label, JSON.stringify(stat));
      }
    } finally {
      await context.close();
    }
  });

  test('@scene opt-in: C3 cardboard normal map scale sweep', async ({ browser, embedURL }) => {
    test.skip(!suppliedRoot, 'Set USD_PLAYGROUND_ROOT to run this opt-in pass.');
    test.setTimeout(590000);
    const { context, page } = await openConditionPage(browser);
    try {
      await loadStageDefaultCamera(page, embedURL);
      const framed = await page.evaluate(() => {
        const dbg = window.__mtlxUsdSceneHandle.__debug();
        let mesh = null;
        dbg.scene.traverse((o) => { if (o.userData && /cardboardseat1/i.test(o.userData.primPath || '') && o.geometry) mesh = o; });
        if (!mesh) return false;
        mesh.geometry.computeBoundingBox();
        mesh.updateWorldMatrix(true, false);
        const bb = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
        const center = { x: (bb.min.x + bb.max.x) / 2, y: (bb.min.y + bb.max.y) / 2, z: (bb.min.z + bb.max.z) / 2 };
        const size = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 0.1;
        const cam = dbg.camera;
        cam.position.set(center.x, center.y, center.z + size * 3);
        cam.lookAt(center.x, center.y, center.z);
        cam.near = Math.max(0.001, size * 0.1);
        cam.far = size * 20;
        cam.updateProjectionMatrix();
        window.__mtlxUsdSceneHandle.renderNow();
        return true;
      });
      if (!framed) { results.captions.push({ file: '(note)', caption: 'C3: could not locate a cardboardSeat1 mesh to frame the close-up camera.' }); return; }
      for (const scale of [1, 0, -1]) {
        await page.evaluate((scale) => {
          const dbg = window.__mtlxUsdSceneHandle.__debug();
          for (const m of dbg.materials) {
            const src = (m.userData && m.userData.mtlxSceneSourceAsset) || '';
            if (/wings\.mtlx$/.test(src) && m.uniforms) {
              const key = Object.keys(m.uniforms).find((k) => /normalmap/i.test(k) && /scale/i.test(k));
              if (key) m.uniforms[key].value = scale;
            }
          }
          window.__mtlxUsdSceneHandle.renderNow();
        }, scale);
        const shot = 'c3-card-normalscale-' + scale + '.png';
        await captureFull(page, shot);
        results.captions.push({ file: shot, caption: 'CARD close-up, wings.mtlx normal map scale = ' + scale + '.' });
      }
    } finally {
      await context.close();
    }
  });
});
