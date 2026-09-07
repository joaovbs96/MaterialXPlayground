// Opt-in headed geometry diagnosis: is the Rook look (glossy streaks in
// Scene, satin on the Viewer shaderball) a property of the real unrefined
// cage mesh under the shared material, or of the renderer/environment?
// Exports the real Rook mesh from the Scene as OBJ, loads that SAME mesh
// under the SAME material in the Viewer, and compares. Not part of any CI
// tier; set USD_CHESS_ROOT to run.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const chessRoot = process.env.USD_CHESS_ROOT || '';
const rookRoot = chessRoot ? path.join(path.dirname(chessRoot), 'assets', 'Rook') : '';
const OUT_DIR = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\ab5';
fs.mkdirSync(OUT_DIR, { recursive: true });
const VIEWPORT = { width: 1400, height: 1100 };

// --- in-page: find the Rook mesh and export it as an OBJ string, plus a
// normal-smoothness statistic (per-corner angle between the vertex normal
// and the triangle's geometric normal). Runs inside the Scene page. ---
function exportRookOBJ() {
  /* eslint-disable no-undef */
  const handle = window.__mtlxUsdSceneHandle;
  const dbg = handle.__debug();
  let mesh = null;
  dbg.scene.traverse((obj) => {
    if (mesh) return;
    if (obj.isMesh && dbg.materials.includes(obj.material)) mesh = obj;
  });
  if (!mesh) return { ok: false, reason: 'no mesh found using one of the debug materials' };

  mesh.updateWorldMatrix(true, false);
  const geo = mesh.geometry;
  const posAttr = geo.attributes.position;
  const nrmAttr = geo.attributes.normal || geo.attributes.i_normal;
  const uvAttr = geo.attributes.uv || geo.attributes.i_texcoord_0;
  const idxAttr = geo.index;

  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const vCount = posAttr.count;

  const positions = new Float32Array(vCount * 3);
  const normals = new Float32Array(vCount * 3);
  const uvs = uvAttr ? new Float32Array(vCount * 2) : null;
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < vCount; i++) {
    p.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
    positions[i * 3] = p.x; positions[i * 3 + 1] = p.y; positions[i * 3 + 2] = p.z;
    if (nrmAttr) {
      n.fromBufferAttribute(nrmAttr, i).applyMatrix3(normalMatrix).normalize();
      normals[i * 3] = n.x; normals[i * 3 + 1] = n.y; normals[i * 3 + 2] = n.z;
    }
    if (uvAttr) { uvs[i * 2] = uvAttr.getX(i); uvs[i * 2 + 1] = uvAttr.getY(i); }
  }

  const triCount = idxAttr ? idxAttr.count / 3 : vCount / 3;
  const angles = [];
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  const na = new THREE.Vector3(), nb = new THREE.Vector3(), nc = new THREE.Vector3();
  const geomN = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    const i0 = idxAttr ? idxAttr.getX(t * 3) : t * 3;
    const i1 = idxAttr ? idxAttr.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idxAttr ? idxAttr.getX(t * 3 + 2) : t * 3 + 2;
    va.set(positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]);
    vb.set(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
    vc.set(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);
    geomN.subVectors(vb, va).cross(new THREE.Vector3().subVectors(vc, va)).normalize();
    if (nrmAttr) {
      na.set(normals[i0 * 3], normals[i0 * 3 + 1], normals[i0 * 3 + 2]);
      nb.set(normals[i1 * 3], normals[i1 * 3 + 1], normals[i1 * 3 + 2]);
      nc.set(normals[i2 * 3], normals[i2 * 3 + 1], normals[i2 * 3 + 2]);
      for (const vn of [na, nb, nc]) {
        const cosA = Math.min(1, Math.max(-1, vn.dot(geomN)));
        angles.push(Math.acos(cosA) * 180 / Math.PI);
      }
    }
  }
  angles.sort((a, b) => a - b);
  const mean = angles.length ? angles.reduce((a, b) => a + b, 0) / angles.length : null;
  const p95 = angles.length ? angles[Math.floor(angles.length * 0.95)] : null;
  const belowOne = angles.length ? angles.filter((a) => a < 1).length / angles.length : null;

  // OBJ text.
  const lines = ['# Rook mesh exported from the USD Scene Viewer debug handle'];
  for (let i = 0; i < vCount; i++) lines.push('v ' + positions[i * 3] + ' ' + positions[i * 3 + 1] + ' ' + positions[i * 3 + 2]);
  if (nrmAttr) for (let i = 0; i < vCount; i++) lines.push('vn ' + normals[i * 3] + ' ' + normals[i * 3 + 1] + ' ' + normals[i * 3 + 2]);
  if (uvAttr) for (let i = 0; i < vCount; i++) lines.push('vt ' + uvs[i * 2] + ' ' + uvs[i * 2 + 1]);
  const faceIdx = (i) => {
    const v = i + 1;
    const t = uvAttr ? v : '';
    const nn = nrmAttr ? v : '';
    if (uvAttr && nrmAttr) return v + '/' + t + '/' + nn;
    if (nrmAttr) return v + '//' + nn;
    if (uvAttr) return v + '/' + t;
    return String(v);
  };
  for (let t = 0; t < triCount; t++) {
    const i0 = idxAttr ? idxAttr.getX(t * 3) : t * 3;
    const i1 = idxAttr ? idxAttr.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idxAttr ? idxAttr.getX(t * 3 + 2) : t * 3 + 2;
    lines.push('f ' + faceIdx(i0) + ' ' + faceIdx(i1) + ' ' + faceIdx(i2));
  }

  const box = new THREE.Box3().setFromObject(mesh);
  const cam = dbg.camera;
  return {
    ok: true,
    obj: lines.join('\n'),
    vertexCount: vCount,
    triangleCount: triCount,
    hasIndex: !!idxAttr,
    normalStats: { mean, p95, belowOneDegFrac: belowOne, sampleCount: angles.length },
    camera: { position: cam.position.toArray(), fov: cam.fov, target: (dbg.scene.userData && dbg.scene.userData.orbitTarget) || null },
    worldBBox: { min: box.min.toArray(), max: box.max.toArray() },
  };
  /* eslint-enable no-undef */
}

async function loadSceneRoot(page, embedURL, dir, rootBasename) {
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
  await page.waitForTimeout(800);
}

function backdropAgainstSilhouette(image) {
  // Median border color as the backdrop reference.
  const border = [];
  for (let x = 0; x < image.width; x++) { border.push(image.getPixel(x, 0)); border.push(image.getPixel(x, image.height - 1)); }
  for (let y = 0; y < image.height; y++) { border.push(image.getPixel(0, y)); border.push(image.getPixel(image.width - 1, y)); }
  const med = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const ref = { r: med(border.map((p) => p.r)), g: med(border.map((p) => p.g)), b: med(border.map((p) => p.b)) };

  const lums = [];
  let bright = 0, count = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const p = image.getPixel(x, y);
    const diff = Math.max(Math.abs(p.r - ref.r), Math.abs(p.g - ref.g), Math.abs(p.b - ref.b));
    if (diff <= 12) continue;
    count++;
    const l = 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;
    lums.push(l);
    if (l > 230) bright++;
  }
  if (!count) return { mean: null, p95: null, brightFrac: null, silhouettePixels: 0 };
  lums.sort((a, b) => a - b);
  const mean = lums.reduce((a, b) => a + b, 0) / lums.length;
  const p95 = lums[Math.floor(lums.length * 0.95)];
  return { mean, p95, brightFrac: bright / count, silhouettePixels: count };
}

// Builds the "normal visualizer" variant of Rook_mat.mtlx in a fresh Temp
// copy of the Rook folder: each standard_surface becomes a surface_unlit
// whose emission_color is 0.5 + 0.5 * world-space shading normal (no
// normal map applied), so smooth vs faceted shading is visible by eye.
function buildNormalVisualizerFolder(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  fs.mkdirSync(path.join(dstDir, 'tex'), { recursive: true });
  for (const f of fs.readdirSync(path.join(srcDir, 'tex'))) {
    fs.copyFileSync(path.join(srcDir, 'tex', f), path.join(dstDir, 'tex', f));
  }
  for (const f of fs.readdirSync(srcDir)) {
    const full = path.join(srcDir, f);
    if (fs.statSync(full).isDirectory()) continue;
    fs.copyFileSync(full, path.join(dstDir, f));
  }
  const mtlxPath = path.join(dstDir, 'Rook_mat.mtlx');
  const original = fs.readFileSync(mtlxPath, 'utf8');

  const visualizer = original.replace(
    /<standard_surface name="([^"]+)" type="surfaceshader">[\s\S]*?<\/standard_surface>/g,
    (match, name) => {
      const suffix = name;
      return [
        `<normal name="nrm_${suffix}" type="vector3">`,
        '  <input name="space" type="string" value="world" />',
        '</normal>',
        `<multiply name="nrm_scaled_${suffix}" type="vector3">`,
        `  <input name="in1" type="vector3" nodename="nrm_${suffix}" />`,
        '  <input name="in2" type="vector3" value="0.5,0.5,0.5" />',
        '</multiply>',
        `<add name="nrm_biased_${suffix}" type="vector3">`,
        `  <input name="in1" type="vector3" nodename="nrm_scaled_${suffix}" />`,
        '  <input name="in2" type="vector3" value="0.5,0.5,0.5" />',
        '</add>',
        `<convert name="nrm_color_${suffix}" type="color3">`,
        `  <input name="in" type="vector3" nodename="nrm_biased_${suffix}" />`,
        '</convert>',
        `<surface_unlit name="${name}" type="surfaceshader">`,
        `  <input name="emission" type="float" value="1.0" />`,
        `  <input name="emission_color" type="color3" nodename="nrm_color_${suffix}" />`,
        '</surface_unlit>',
      ].join('\n');
    },
  );
  fs.writeFileSync(mtlxPath, visualizer, 'utf8');
  return dstDir;
}

async function setDisplayTransformViewer(page, value) {
  await page.evaluate((v) => { if (window.setDisplayTransform) window.setDisplayTransform(v); }, value);
  await page.waitForTimeout(500);
}

async function setDisplayTransformScene(page, value) {
  const combos = page.getByRole('combobox');
  for (let i = 0; i < await combos.count(); i++) {
    const el = combos.nth(i);
    const opts = await el.locator('option').allTextContents().catch(() => []);
    if (opts.some((o) => /lin_rec709|sRGB|ACES/.test(o))) { await el.selectOption(value).catch(() => {}); return; }
  }
}

test.describe('@scene Rook geometry diagnosis (opt-in)', () => {
  test.skip(!chessRoot, 'Set USD_CHESS_ROOT to run this diagnostic.');
  test.setTimeout(900000);

  let sceneExport = null;
  const report = [];

  test('1. Scene leg: export the real Rook mesh as OBJ', async ({ page, embedURL }) => {
    await page.setViewportSize(VIEWPORT);
    await loadSceneRoot(page, embedURL, rookRoot, 'Rook.usd');

    const result = await page.evaluate(exportRookOBJ);
    expect(result.ok).toBeTruthy();
    sceneExport = result;
    fs.writeFileSync(path.join(OUT_DIR, 'rook-scene.obj'), result.obj, 'utf8');
    await page.getByTestId('usd-scene-canvas').screenshot({ path: path.join(OUT_DIR, 'rook-scene.png') });

    report.push('## 1. Scene mesh export');
    report.push('- vertexCount: ' + result.vertexCount);
    report.push('- triangleCount: ' + result.triangleCount);
    report.push('- hasIndex: ' + result.hasIndex);
    report.push('- normal smoothness: mean=' + result.normalStats.mean + ' deg, p95=' + result.normalStats.p95 + ' deg, fraction<1deg=' + result.normalStats.belowOneDegFrac + ' (n=' + result.normalStats.sampleCount + ' corners)');
    report.push('- camera: ' + JSON.stringify(result.camera));
    report.push('- world bbox: ' + JSON.stringify(result.worldBBox));
    report.push('');
  });

  test('2. Viewer leg: same material, then the exported OBJ mesh', async ({ page, embedURL }) => {
    test.skip(!sceneExport, 'Scene export did not run');
    await page.setViewportSize(VIEWPORT);
    await page.goto(embedURL + '/index.html#!viewer');
    // Let the default material settle first, exactly as usd-scene-gpu-state.spec.mjs.
    await page.waitForFunction(() => !document.body.innerText.includes('Generating shader'), { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);

    await page.locator('input[type=file][webkitdirectory]').first().setInputFiles(rookRoot);
    await page.waitForFunction(() => !document.body.innerText.includes('Generating shader'), { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.waitForFunction(() => !!window.__mtlxViewerHandle, { timeout: 20000 }).catch(() => {});

    await page.locator('canvas').first().screenshot({ path: path.join(OUT_DIR, 'rook-viewer-ball.png') });

    const objPath = path.join(OUT_DIR, 'rook-scene.obj');
    await page.locator('input[type=file][accept*=".obj"]').first().setInputFiles(objPath);

    await page.waitForFunction((expectedCount) => {
      const h = window.__mtlxViewerHandle;
      if (!h || typeof h.__debug !== 'function') return false;
      const dbg = h.__debug();
      let found = false;
      dbg.scene.traverse((obj) => {
        if (found) return;
        if (obj.isMesh && obj.geometry && obj.geometry.attributes.position && obj.geometry.attributes.position.count === expectedCount) found = true;
      });
      return found;
    }, sceneExport.vertexCount, { timeout: 30000 }).catch(() => {});

    await page.waitForFunction(() => {
      const h = window.__mtlxViewerHandle;
      if (!h || typeof h.__debug !== 'function' || !window.samplerHoldsDefault) return true;
      const dbg = h.__debug();
      const mat = dbg.material;
      if (!mat || !mat.uniforms) return true;
      for (const name of Object.keys(mat.uniforms)) {
        if (!/file|map|tex/i.test(name)) continue;
        const v = mat.uniforms[name].value;
        if (v && v.isTexture && window.samplerHoldsDefault({ value: v })) return false;
      }
      return true;
    }, {}, { timeout: 30000 }).catch(() => {});

    await setDisplayTransformViewer(page, 'srgb');
    await page.evaluate(() => { if (window.__setBackdropModeForTest) window.__setBackdropModeForTest('studio'); });
    try {
      const backdropRow = page.locator('text=Backdrop').locator('..').getByRole('combobox');
      if (await backdropRow.count()) {
        await backdropRow.first().click();
        const opt = page.getByRole('option', { name: 'Studio', exact: true });
        if (await opt.count()) await opt.click();
      }
    } catch (e) { report.push('Backdrop selector interaction skipped: ' + String(e)); }
    await page.waitForTimeout(500);

    await page.locator('canvas').first().screenshot({ path: path.join(OUT_DIR, 'rook-viewer-mesh.png') });

    report.push('## 2. Viewer mesh load');
    report.push('- loaded ab5/rook-scene.obj into the Geometry card, material = Rook folder');
    report.push('- screenshots: rook-viewer-ball.png (default shaderball reference), rook-viewer-mesh.png (real mesh)');
    report.push('');
  });

  test('3. Normal visualizer, both legs', async ({ page, embedURL }) => {
    test.skip(!sceneExport, 'Scene export did not run');
    const visDir = path.join(os.tmpdir(), 'mxpt-rook-normal-vis');
    fs.rmSync(visDir, { recursive: true, force: true });
    buildNormalVisualizerFolder(rookRoot, visDir);

    await page.setViewportSize(VIEWPORT);
    await loadSceneRoot(page, embedURL, visDir, 'Rook.usd');
    await setDisplayTransformScene(page, 'lin_rec709');
    await page.waitForTimeout(500);
    await page.getByTestId('usd-scene-canvas').screenshot({ path: path.join(OUT_DIR, 'rook-scene-normals.png') });

    await page.goto(embedURL + '/index.html#!viewer');
    await page.waitForFunction(() => !document.body.innerText.includes('Generating shader'), { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.locator('input[type=file][webkitdirectory]').first().setInputFiles(visDir);
    await page.waitForFunction(() => !document.body.innerText.includes('Generating shader'), { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.locator('input[type=file][accept*=".obj"]').first().setInputFiles(path.join(OUT_DIR, 'rook-scene.obj'));
    await page.waitForFunction((expectedCount) => {
      const h = window.__mtlxViewerHandle;
      if (!h || typeof h.__debug !== 'function') return false;
      const dbg = h.__debug();
      let found = false;
      dbg.scene.traverse((obj) => {
        if (found) return;
        if (obj.isMesh && obj.geometry && obj.geometry.attributes.position && obj.geometry.attributes.position.count === expectedCount) found = true;
      });
      return found;
    }, sceneExport.vertexCount, { timeout: 30000 }).catch(() => {});
    await setDisplayTransformViewer(page, 'lin_rec709');
    await page.waitForTimeout(500);
    await page.locator('canvas').first().screenshot({ path: path.join(OUT_DIR, 'rook-viewer-mesh-normals.png') });

    report.push('## 3. Normal visualizer');
    report.push('- variant folder: ' + visDir);
    report.push('- screenshots: rook-scene-normals.png, rook-viewer-mesh-normals.png');
    report.push('- inspect by eye: smooth gradient across cage faces = smooth shading normals; hard edges per triangle = faceted');
    report.push('');
  });

  test.afterAll(() => {
    const paths = ['rook-scene.png', 'rook-viewer-mesh.png'];
    const rows = [];
    for (const name of paths) {
      const full = path.join(OUT_DIR, name);
      if (!fs.existsSync(full)) { rows.push({ name, stats: null }); continue; }
      const img = decodePNG(fs.readFileSync(full));
      rows.push({ name, stats: backdropAgainstSilhouette(img) });
    }

    const md = [];
    md.push('# Rook geometry diagnosis (opt-in)');
    md.push('');
    md.push('Scene draws the real unrefined catmullClark cage; the Viewer leg here loads');
    md.push('the SAME exported mesh (as OBJ) under the SAME Rook_mat.mtlx material.');
    md.push('');
    md.push(...report);
    md.push('## 4. Silhouette metrics (backdrop = median border color, threshold 12/channel)');
    md.push('| image | mean luminance | p95 | fraction>230 | silhouette px |');
    md.push('|---|---|---|---|---|');
    for (const r of rows) {
      if (!r.stats) { md.push('| ' + r.name + ' | (missing) | | | |'); continue; }
      const s = r.stats;
      md.push('| ' + r.name + ' | ' + (s.mean == null ? 'n/a' : s.mean.toFixed(2)) + ' | ' + (s.p95 == null ? 'n/a' : s.p95.toFixed(2)) + ' | ' + (s.brightFrac == null ? 'n/a' : s.brightFrac.toFixed(4)) + ' | ' + s.silhouettePixels + ' |');
    }
    md.push('');
    if (sceneExport) {
      md.push('## Normal smoothness statistic (Scene mesh export)');
      md.push('mean=' + sceneExport.normalStats.mean + ' deg, p95=' + sceneExport.normalStats.p95 + ' deg, fraction<1deg=' + sceneExport.normalStats.belowOneDegFrac);
      md.push('');
    }
    md.push('## Verdict');
    md.push('See final chat message for the reasoned verdict comparing rook-scene.png against rook-viewer-mesh.png,');
    md.push('and rook-scene-normals.png against rook-viewer-mesh-normals.png.');
    md.push('');
    fs.writeFileSync(path.join(OUT_DIR, 'REPORT.md'), md.join('\n'), 'utf8');
  });
});
