// Opt-in headed state diff: Viewer (rook-product-sub0.obj under the Rook
// material) vs Scene (Rook alone, Subdivision Off), the exact pairing that
// visually differs (soft grooves vs hard specular streaks). Collects full
// shader/uniform/geometry/renderer/GL state for both legs plus two Scene
// controls (u_peelLinear, deindexed-recomputed tangent frame), then writes
// a unified DIFF.md. Not part of any CI tier; set USD_CHESS_ROOT to run.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './lib/test-base.mjs';

const chessRoot = process.env.USD_CHESS_ROOT || '';
const rookRoot = chessRoot ? path.join(path.dirname(chessRoot), 'assets', 'Rook') : '';
const OUT_DIR = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\ab16';
fs.mkdirSync(OUT_DIR, { recursive: true });
const VIEWPORT = { width: 1400, height: 1100 };
const OBJ_SUB0 = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\ab14\\rook-product-sub0.obj';

// ---- in-page collector, identical shape for both legs ----
function collectState(materialMatch) {
  /* eslint-disable no-undef */
  const isScene = !!window.__mtlxUsdSceneHandle && materialMatch === 'scene';
  const handle = isScene ? window.__mtlxUsdSceneHandle : window.__mtlxViewerHandle;
  const dbg = handle.__debug();
  const renderer = dbg.renderer;
  const scene = dbg.scene;
  let material = null;
  if (isScene) {
    for (const m of dbg.materials) {
      const p = (m.userData && m.userData.mtlxSceneMaterialPath) || '';
      if (/rook/i.test(p) || /black/i.test(p)) { material = m; break; }
    }
    if (!material) material = dbg.materials[0];
  } else {
    material = dbg.material;
  }
  let mesh = null;
  scene.traverse((obj) => { if (!mesh && obj.isMesh && obj.material === material) mesh = obj; });

  const isTextureLike = (v) => v && typeof v === 'object' && v.isTexture;
  const serializeValue = (v) => {
    if (v == null) return v;
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) return v.map(serializeValue);
    if (isTextureLike(v)) {
      const tex = v;
      const props = renderer.properties.get(tex) || {};
      return {
        __kind: 'texture',
        width: (tex.image && tex.image.width) || null,
        height: (tex.image && tex.image.height) || null,
        format: tex.format,
        type: tex.type,
        minFilter: tex.minFilter,
        magFilter: tex.magFilter,
        generateMipmaps: tex.generateMipmaps,
        mapping: tex.mapping,
        flipY: tex.flipY,
        encoding: tex.encoding,
        anisotropy: tex.anisotropy,
        wrapS: tex.wrapS,
        wrapT: tex.wrapT,
        version: tex.version,
        isDefault: window.samplerHoldsDefault ? window.samplerHoldsDefault({ value: tex }) : null,
        __maxMipLevel: props.__maxMipLevel !== undefined ? props.__maxMipLevel : null,
        __version: props.__version !== undefined ? props.__version : null,
      };
    }
    if (typeof v.toArray === 'function') return { __kind: 'vecOrMat', values: v.toArray() };
    return { __kind: 'object', keys: Object.keys(v) };
  };

  const uniforms = {};
  for (const name of Object.keys(material.uniforms || {})) {
    uniforms[name] = serializeValue(material.uniforms[name] ? material.uniforms[name].value : undefined);
  }

  const materialFlags = {
    side: material.side,
    transparent: material.transparent,
    depthWrite: material.depthWrite,
    depthTest: material.depthTest,
    blending: material.blending,
    premultipliedAlpha: material.premultipliedAlpha,
    toneMapped: material.toneMapped,
    extensions: material.extensions,
    vertexColors: material.vertexColors,
    flatShading: material.flatShading,
    glslVersion: material.glslVersion,
    defines: material.defines,
  };

  // Geometry attribute inventory + per-vertex statistics.
  let geometryInfo = null;
  if (mesh && mesh.geometry) {
    const g = mesh.geometry;
    const attrs = {};
    for (const name of Object.keys(g.attributes)) {
      const a = g.attributes[name];
      attrs[name] = { itemSize: a.itemSize, count: a.count, normalized: !!a.normalized };
    }
    const stat = (nameN, nameT, nameB, nameUV) => {
      const N = g.getAttribute(nameN), T = g.getAttribute(nameT), B = g.getAttribute(nameB), UV = g.getAttribute(nameUV);
      const out = {};
      const lenStats = (attr) => {
        if (!attr) return null;
        let sum = 0, min = Infinity, max = -Infinity, nonFinite = 0;
        for (let i = 0; i < attr.count; i++) {
          const x = attr.getX(i), y = attr.getY(i), z = attr.getZ(i);
          const len = Math.hypot(x, y, z);
          if (!isFinite(x) || !isFinite(y) || !isFinite(z)) { nonFinite++; continue; }
          sum += len; if (len < min) min = len; if (len > max) max = len;
        }
        return { meanLen: sum / attr.count, minLen: min, maxLen: max, nonFiniteFrac: nonFinite / attr.count };
      };
      out.normal = lenStats(N);
      out.tangent = lenStats(T);
      out.bitangent = lenStats(B);
      if (N && T && B) {
        let sumNT = 0, sumNB = 0, sumHand = 0, posCount = 0, n = N.count;
        for (let i = 0; i < n; i++) {
          const nx = N.getX(i), ny = N.getY(i), nz = N.getZ(i);
          const tx = T.getX(i), ty = T.getY(i), tz = T.getZ(i);
          const bx = B.getX(i), by = B.getY(i), bz = B.getZ(i);
          sumNT += Math.abs(nx * tx + ny * ty + nz * tz);
          sumNB += Math.abs(nx * bx + ny * by + nz * bz);
          const cx = ny * tz - nz * ty, cy = nz * tx - nx * tz, cz = nx * ty - ny * tx;
          const hand = cx * bx + cy * by + cz * bz;
          sumHand += hand;
          if (hand > 0) posCount++;
        }
        out.meanAbsDotNT = sumNT / n;
        out.meanAbsDotNB = sumNB / n;
        out.meanHandedness = sumHand / n;
        out.fracHandednessPositive = posCount / n;
      }
      if (UV) {
        let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
        for (let i = 0; i < UV.count; i++) {
          const u = UV.getX(i), v = UV.getY(i);
          if (u < minU) minU = u; if (u > maxU) maxU = u;
          if (v < minV) minV = v; if (v > maxV) maxV = v;
        }
        out.uv = { minU, maxU, minV, maxV };
      }
      return out;
    };
    geometryInfo = {
      attributes: attrs,
      hasIndex: !!g.index,
      indexCount: g.index ? g.index.count : null,
      stats: stat('i_normal', 'i_tangent', 'i_bitangent', 'i_texcoord_0'),
      matrixWorld: mesh.matrixWorld.toArray(),
      matrixWorldDeterminant: mesh.matrixWorld.determinant(),
      frustumCulled: mesh.frustumCulled,
      renderOrder: mesh.renderOrder,
      castShadow: mesh.castShadow,
      receiveShadow: mesh.receiveShadow,
    };
  }

  // Render one frame to populate renderer.info.render.
  renderer.render(scene, dbg.camera);
  const gl = renderer.getContext();
  const clearColor = new THREE.Color();
  renderer.getClearColor(clearColor);
  const rendererFacts = {
    outputEncoding: renderer.outputEncoding,
    toneMapping: renderer.toneMapping,
    toneMappingExposure: renderer.toneMappingExposure,
    pixelRatio: renderer.getPixelRatio(),
    shadowMapEnabled: renderer.shadowMap.enabled,
    shadowMapType: renderer.shadowMap.type,
    isWebGL2: renderer.capabilities.isWebGL2,
    maxAnisotropy: renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : renderer.capabilities.maxAnisotropy,
    precision: renderer.capabilities.precision,
    hasColorBufferFloat: !!renderer.extensions.get('EXT_color_buffer_float'),
    infoRender: Object.assign({}, renderer.info.render),
    clearColorHex: clearColor.getHex(),
    clearAlpha: renderer.getClearAlpha(),
    canvasWidth: renderer.domElement.width,
    canvasHeight: renderer.domElement.height,
    cameraNear: dbg.camera.near,
    cameraFar: dbg.camera.far,
    cameraFov: dbg.camera.fov,
    cameraPosition: dbg.camera.position.toArray(),
    cameraMatrixWorldInverse: dbg.camera.matrixWorldInverse.toArray(),
  };

  // GL state on env radiance + normal map samplers.
  const glRecords = {};
  const anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
  const recordTex = (tex) => {
    const props = renderer.properties.get(tex) || {};
    const webglTex = props.__webglTexture;
    if (!webglTex) return { hasWebglTexture: false };
    const prevBinding = gl.getParameter(gl.TEXTURE_BINDING_2D);
    gl.bindTexture(gl.TEXTURE_2D, webglTex);
    const rec = {
      TEXTURE_MIN_FILTER: gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER),
      TEXTURE_MAG_FILTER: gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER),
      TEXTURE_WRAP_S: gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S),
      TEXTURE_WRAP_T: gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T),
      TEXTURE_MAX_LEVEL: gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL),
      TEXTURE_BASE_LEVEL: gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL),
      TEXTURE_MAX_ANISOTROPY_EXT: anisoExt ? gl.getTexParameter(gl.TEXTURE_2D, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT) : null,
    };
    gl.bindTexture(gl.TEXTURE_2D, prevBinding);
    return rec;
  };
  for (const name of Object.keys(material.uniforms || {})) {
    if (/env(Radiance|Irradiance)/i.test(name)) {
      const tex = material.uniforms[name].value;
      if (isTextureLike(tex)) glRecords[name] = recordTex(tex);
    }
    if (/normal/i.test(name) && /file|map|tex/i.test(name)) {
      const tex = material.uniforms[name].value;
      if (isTextureLike(tex)) glRecords[name] = recordTex(tex);
    }
  }

  const sceneGraph = [];
  scene.traverse((obj) => {
    sceneGraph.push({
      type: obj.type,
      name: obj.name || null,
      materialType: obj.material ? obj.material.type : null,
      visible: obj.visible,
    });
  });

  return {
    vertexShader: material.vertexShader,
    fragmentShader: material.fragmentShader,
    materialFlags,
    uniforms,
    geometryInfo,
    rendererFacts,
    glRecords,
    sceneGraph,
  };
  /* eslint-enable no-undef */
}

function normalizeShader(src) {
  return (src || '').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

function lineDiff(aLines, bLines) {
  const n = aLines.length, m = bLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) { i++; j++; continue; }
    if (dp[i + 1][j] >= dp[i][j + 1]) { out.push('- ' + aLines[i]); i++; }
    else { out.push('+ ' + bLines[j]); j++; }
  }
  while (i < n) { out.push('- ' + aLines[i]); i++; }
  while (j < m) { out.push('+ ' + bLines[j]); j++; }
  return out;
}

test.describe('@scene Rook state diff: Viewer sub0 vs Scene subdivision-off (opt-in)', () => {
  test.skip(!chessRoot, 'Set USD_CHESS_ROOT to run this diagnostic.');
  test.setTimeout(900000);

  test('collect Viewer(A) and Scene(B) state, diff, and run two controls', async ({ page, context, embedURL }) => {
    await page.setViewportSize(VIEWPORT);

    // --- Leg A: Viewer, rook-product-sub0.obj under the Rook material, Backdrop Studio ---
    await page.goto(embedURL + '/index.html#!viewer');
    await page.waitForFunction(() => !document.body.innerText.includes('Generating shader'), { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.locator('input[type=file][webkitdirectory]').first().setInputFiles(rookRoot);
    await page.waitForFunction(() => !document.body.innerText.includes('Generating shader'), { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.waitForFunction(() => !!window.__mtlxViewerHandle, { timeout: 20000 }).catch(() => {});
    await page.locator('input[type=file][accept*=".obj"]').first().setInputFiles(OBJ_SUB0);
    await page.waitForFunction(() => {
      const h = window.__mtlxViewerHandle;
      if (!h || typeof h.__debug !== 'function') return false;
      const dbg = h.__debug();
      let found = false;
      dbg.scene.traverse((obj) => { if (!found && obj.isMesh && obj.material === dbg.material) found = true; });
      return found;
    }, {}, { timeout: 30000 }).catch(() => {});
    await page.evaluate(() => { if (window.setDisplayTransform) window.setDisplayTransform('srgb'); });
    await page.evaluate(() => { if (window.__setBackdropModeForTest) window.__setBackdropModeForTest('studio'); });
    try {
      const backdropRow = page.locator('text=Backdrop').locator('..').getByRole('combobox');
      if (await backdropRow.count()) {
        await backdropRow.first().click();
        const opt = page.getByRole('option', { name: 'Studio', exact: true });
        if (await opt.count()) await opt.click();
      }
    } catch (e) { /* backdrop selector interaction skipped */ }
    await page.waitForTimeout(700);

    const stateA = await page.evaluate(({ fn }) => (0, eval)('(' + fn + ')')('viewer'), { fn: collectState.toString() });
    fs.writeFileSync(path.join(OUT_DIR, 'A-vertex.txt'), stateA.vertexShader || '', 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'A-fragment.txt'), stateA.fragmentShader || '', 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'A-uniforms.json'), JSON.stringify(stateA.uniforms, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'A-geometry.json'), JSON.stringify(stateA.geometryInfo, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'A-renderer.json'), JSON.stringify(stateA.rendererFacts, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'A-gl.json'), JSON.stringify(stateA.glRecords, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'A-scenegraph.json'), JSON.stringify(stateA.sceneGraph, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'A-flags.json'), JSON.stringify(stateA.materialFlags, null, 2), 'utf8');
    await page.locator('canvas').first().screenshot({ path: path.join(OUT_DIR, 'A-screenshot.png') });

    // --- Leg B: Scene, Rook alone, Subdivision Off ---
    // A fresh page is required here: chaining the Scene navigation onto the
    // same page used for the Viewer leg leaves the folder <input> unable to
    // ingest a dropped directory (reproduced independently; the app carries
    // some navigation state that breaks a second webkitdirectory pick on a
    // reused page). A brand-new page sidesteps it without touching app code.
    const page2 = await context.newPage();
    await page2.setViewportSize(VIEWPORT);
    await page2.addInitScript(() => { try { localStorage.setItem('mtlx_scene_subdivision', '0'); } catch (e) {} });
    await page2.goto(embedURL + '/index.html#!scene');
    await expect(page2.getByTestId('usd-scene-viewer')).toBeVisible();
    await page2.locator('input[type=file][webkitdirectory]').first().setInputFiles(rookRoot);
    await expect(page2.getByTestId('usd-scene-root-select')).toBeVisible({ timeout: 30000 });
    const rootCombobox = page2.getByTestId('usd-scene-root-select').getByRole('combobox');
    if (await rootCombobox.count()) {
      await rootCombobox.click();
      const options = await page2.getByRole('option').allTextContents();
      const selected = options.find((l) => l.endsWith('/Rook.usd') || l === 'Rook.usd');
      if (selected) await page2.getByRole('option', { name: selected, exact: true }).click();
    }
    try {
      const subRow = page2.locator('text=Subdivision').locator('..').getByRole('combobox');
      if (await subRow.count()) {
        await subRow.first().click();
        const opt0 = page2.getByRole('option', { name: 'Off', exact: true });
        if (await opt0.count()) await opt0.click();
        else {
          const optZero = page2.getByRole('option', { name: '0', exact: true });
          if (await optZero.count()) await optZero.click();
        }
      }
    } catch (e) { /* subdivision selector interaction skipped */ }
    await page2.getByTestId('usd-scene-sidebar').getByRole('button', { name: /^Load (?!example)/ }).click();
    await expect(page2.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 180000 });
    await page2.waitForTimeout(800);

    const stateB = await page2.evaluate(({ fn }) => (0, eval)('(' + fn + ')')('scene'), { fn: collectState.toString() });
    fs.writeFileSync(path.join(OUT_DIR, 'B-vertex.txt'), stateB.vertexShader || '', 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'B-fragment.txt'), stateB.fragmentShader || '', 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'B-uniforms.json'), JSON.stringify(stateB.uniforms, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'B-geometry.json'), JSON.stringify(stateB.geometryInfo, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'B-renderer.json'), JSON.stringify(stateB.rendererFacts, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'B-gl.json'), JSON.stringify(stateB.glRecords, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'B-scenegraph.json'), JSON.stringify(stateB.sceneGraph, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'B-flags.json'), JSON.stringify(stateB.materialFlags, null, 2), 'utf8');
    await page2.getByTestId('usd-scene-canvas').screenshot({ path: path.join(OUT_DIR, 'B-screenshot.png') });

    // ---- Control (a): u_peelLinear forced to 1 on the Scene material ----
    const peelResult = await page2.evaluate(() => {
      const h = window.__mtlxUsdSceneHandle;
      const dbg = h.__debug();
      let mat = null;
      for (const m of dbg.materials) {
        const p = (m.userData && m.userData.mtlxSceneMaterialPath) || '';
        if (/rook/i.test(p) || /black/i.test(p)) { mat = m; break; }
      }
      if (!mat) mat = dbg.materials[0];
      if (!mat.uniforms.u_peelLinear) return { hasUniform: false };
      const orig = mat.uniforms.u_peelLinear.value;
      mat.uniforms.u_peelLinear.value = 1;
      mat.uniformsNeedUpdate = true;
      return { hasUniform: true, orig };
    });
    if (peelResult.hasUniform) {
      await page2.evaluate(() => { const h = window.__mtlxUsdSceneHandle; const dbg = h.__debug(); dbg.renderer.render(dbg.scene, dbg.camera); });
      await page2.waitForTimeout(50);
      await page2.evaluate(() => { const h = window.__mtlxUsdSceneHandle; const dbg = h.__debug(); dbg.renderer.render(dbg.scene, dbg.camera); });
      await page2.getByTestId('usd-scene-canvas').screenshot({ path: path.join(OUT_DIR, 'control-a-peel1.png') });
      await page2.evaluate((orig) => {
        const h = window.__mtlxUsdSceneHandle; const dbg = h.__debug();
        let mat = null;
        for (const m of dbg.materials) {
          const p = (m.userData && m.userData.mtlxSceneMaterialPath) || '';
          if (/rook/i.test(p) || /black/i.test(p)) { mat = m; break; }
        }
        if (!mat) mat = dbg.materials[0];
        mat.uniforms.u_peelLinear.value = orig;
        mat.uniformsNeedUpdate = true;
        dbg.renderer.render(dbg.scene, dbg.camera);
      }, peelResult.orig);
    }

    // ---- Control (b): replace i_tangent/i_bitangent with per-triangle frames on a deindexed copy ----
    const tangentResult = await page2.evaluate(() => {
      /* eslint-disable no-undef */
      const h = window.__mtlxUsdSceneHandle;
      const dbg = h.__debug();
      let mesh = null, mat = null;
      for (const m of dbg.materials) {
        const p = (m.userData && m.userData.mtlxSceneMaterialPath) || '';
        if (/rook/i.test(p) || /black/i.test(p)) { mat = m; break; }
      }
      if (!mat) mat = dbg.materials[0];
      dbg.scene.traverse((obj) => { if (!mesh && obj.isMesh && obj.material === mat) mesh = obj; });
      if (!mesh) return { ok: false };
      const geometry = mesh.geometry.toNonIndexed();
      const position = geometry.getAttribute('position');
      let normal = geometry.getAttribute('normal');
      if (!normal) { geometry.computeVertexNormals(); normal = geometry.getAttribute('normal'); }
      let uv = geometry.getAttribute('uv') || geometry.getAttribute('i_texcoord_0');
      if (!uv) uv = new THREE.BufferAttribute(new Float32Array(position.count * 2), 2);
      const writeFrame = (index, tx, ty, tz, sign, tangentOut, bitangentOut) => {
        let nx = normal.getX(index), ny = normal.getY(index), nz = normal.getZ(index);
        const nlen = Math.hypot(nx, ny, nz);
        if (nlen > 1e-10) { nx /= nlen; ny /= nlen; nz /= nlen; } else { nx = 0; ny = 0; nz = 1; }
        const ndot = tx * nx + ty * ny + tz * nz;
        tx -= ndot * nx; ty -= ndot * ny; tz -= ndot * nz;
        let tlen = Math.hypot(tx, ty, tz);
        if (tlen < 1e-10) {
          const ax = Math.abs(nx) < 0.9 ? 1 : 0;
          const ay = ax ? 0 : 1;
          tx = ay * nz; ty = ax * nz; tz = -ay * nx - ax * ny;
          tlen = Math.hypot(tx, ty, tz) || 1;
        }
        tx /= tlen; ty /= tlen; tz /= tlen;
        const bx = (ny * tz - nz * ty) * (sign < 0 ? -1 : 1);
        const by = (nz * tx - nx * tz) * (sign < 0 ? -1 : 1);
        const bz = (nx * ty - ny * tx) * (sign < 0 ? -1 : 1);
        tangentOut[index * 3] = tx; tangentOut[index * 3 + 1] = ty; tangentOut[index * 3 + 2] = tz;
        bitangentOut[index * 3] = bx; bitangentOut[index * 3 + 1] = by; bitangentOut[index * 3 + 2] = bz;
      };
      const tangents = new Float32Array(position.count * 3);
      const bitangents = new Float32Array(position.count * 3);
      for (let base = 0; base + 2 < position.count; base += 3) {
        const ax = position.getX(base + 1) - position.getX(base);
        const ay = position.getY(base + 1) - position.getY(base);
        const az = position.getZ(base + 1) - position.getZ(base);
        const bx = position.getX(base + 2) - position.getX(base);
        const by = position.getY(base + 2) - position.getY(base);
        const bz = position.getZ(base + 2) - position.getZ(base);
        const du1 = uv.getX(base + 1) - uv.getX(base), dv1 = uv.getY(base + 1) - uv.getY(base);
        const du2 = uv.getX(base + 2) - uv.getX(base), dv2 = uv.getY(base + 2) - uv.getY(base);
        const det = du1 * dv2 - du2 * dv1;
        if (Math.abs(det) < 1e-10) continue;
        const inv = 1 / det;
        const tx = (ax * dv2 - bx * dv1) * inv;
        const ty = (ay * dv2 - by * dv1) * inv;
        const tz = (az * dv2 - bz * dv1) * inv;
        const cx = (bx * du1 - ax * du2) * inv;
        const cy = (by * du1 - ay * du2) * inv;
        const cz = (bz * du1 - az * du2) * inv;
        for (let j = 0; j < 3; j++) {
          const i = base + j;
          tangents[i * 3] = tx; tangents[i * 3 + 1] = ty; tangents[i * 3 + 2] = tz;
          bitangents[i * 3] = cx; bitangents[i * 3 + 1] = cy; bitangents[i * 3 + 2] = cz;
        }
      }
      for (let i = 0; i < position.count; i++) {
        const tx = tangents[i * 3], ty = tangents[i * 3 + 1], tz = tangents[i * 3 + 2];
        const nx = normal.getX(i), ny = normal.getY(i), nz = normal.getZ(i);
        const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
        const sign = bx * bitangents[i * 3] + by * bitangents[i * 3 + 1] + bz * bitangents[i * 3 + 2] < 0 ? -1 : 1;
        writeFrame(i, tx, ty, tz, sign, tangents, bitangents);
      }
      geometry.setAttribute('i_tangent', new THREE.BufferAttribute(tangents, 3));
      geometry.setAttribute('i_bitangent', new THREE.BufferAttribute(bitangents, 3));
      if (!geometry.getAttribute('i_position')) geometry.setAttribute('i_position', geometry.getAttribute('position'));
      if (!geometry.getAttribute('i_normal')) geometry.setAttribute('i_normal', normal);
      if (!geometry.getAttribute('i_texcoord_0')) geometry.setAttribute('i_texcoord_0', uv);
      mesh.geometry = geometry;
      dbg.renderer.render(dbg.scene, dbg.camera);
      return { ok: true };
      /* eslint-enable no-undef */
    });
    if (tangentResult.ok) {
      await page2.waitForTimeout(50);
      await page2.evaluate(() => { const h = window.__mtlxUsdSceneHandle; const dbg = h.__debug(); dbg.renderer.render(dbg.scene, dbg.camera); });
      await page2.getByTestId('usd-scene-canvas').screenshot({ path: path.join(OUT_DIR, 'control-b-recomputed-tangents.png') });
    }

    // ---- crops ----
    // Base bevel region: fixed crop window centered on the lower third of the canvas.
    const cropRegion = async (screenshotName, cropName) => {
      const buf = fs.readFileSync(path.join(OUT_DIR, screenshotName));
      // Use sharp-free approach: reuse decodePNG via lib/png.mjs.
      const { decodePNG } = await import('./lib/png.mjs');
      const image = decodePNG(buf);
      const w = 320, h = 240, scale = 2;
      const x0 = Math.max(0, Math.floor(image.width / 2) - Math.floor(w / 2));
      const y0 = Math.max(0, Math.floor(image.height * 0.62) - Math.floor(h / 2));
      const outW = w * scale, outH = h * scale;
      const rgba = Buffer.alloc(outW * outH * 4);
      for (let y = 0; y < outH; y++) {
        for (let x = 0; x < outW; x++) {
          const sx = Math.min(image.width - 1, x0 + Math.floor(x / scale));
          const sy = Math.min(image.height - 1, y0 + Math.floor(y / scale));
          const p = image.getPixel(sx, sy);
          const o = (y * outW + x) * 4;
          rgba[o] = p.r; rgba[o + 1] = p.g; rgba[o + 2] = p.b; rgba[o + 3] = p.a;
        }
      }
      const zlib = await import('node:zlib');
      const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
        const typeBuf = Buffer.from(type, 'ascii');
        const crcBuf = Buffer.concat([typeBuf, data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(crcBuf), 0);
        return Buffer.concat([len, typeBuf, data, crc]);
      };
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(outW, 0); ihdr.writeUInt32BE(outH, 4);
      ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
      const raw = Buffer.alloc((outW * 4 + 1) * outH);
      for (let y = 0; y < outH; y++) {
        raw[y * (outW * 4 + 1)] = 0;
        rgba.copy(raw, y * (outW * 4 + 1) + 1, y * outW * 4, (y + 1) * outW * 4);
      }
      const idat = zlib.deflateSync(raw);
      const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
      fs.writeFileSync(path.join(OUT_DIR, cropName), png);
    };
    await cropRegion('A-screenshot.png', 'crop-A.png');
    await cropRegion('B-screenshot.png', 'crop-B.png');

    // ---- DIFF.md ----
    const fragDiff = lineDiff(normalizeShader(stateA.fragmentShader), normalizeShader(stateB.fragmentShader));
    const vertDiff = lineDiff(normalizeShader(stateA.vertexShader), normalizeShader(stateB.vertexShader));
    const uniformDiffLines = [];
    const allNames = new Set([...Object.keys(stateA.uniforms || {}), ...Object.keys(stateB.uniforms || {})]);
    for (const name of allNames) {
      const a = JSON.stringify(stateA.uniforms ? stateA.uniforms[name] : undefined);
      const b = JSON.stringify(stateB.uniforms ? stateB.uniforms[name] : undefined);
      if (a !== b) uniformDiffLines.push('| ' + name + ' | ' + (a || '(missing)') + ' | ' + (b || '(missing)') + ' |');
    }

    const md = [];
    md.push('# Rook state diff: Viewer (A, sub0 OBJ) vs Scene (B, subdivision off)');
    md.push('');
    md.push('## Fragment shader diff (normalized whitespace, ' + fragDiff.length + ' differing lines)');
    md.push('```diff');
    md.push(...fragDiff.slice(0, 500));
    if (fragDiff.length > 500) md.push('... truncated, see A-fragment.txt / B-fragment.txt');
    md.push('```');
    md.push('');
    md.push('## Vertex shader diff (normalized whitespace, ' + vertDiff.length + ' differing lines)');
    md.push('```diff');
    md.push(...vertDiff.slice(0, 500));
    if (vertDiff.length > 500) md.push('... truncated, see A-vertex.txt / B-vertex.txt');
    md.push('```');
    md.push('');
    md.push('## Differing uniforms');
    md.push('| name | A (Viewer) | B (Scene) |');
    md.push('|---|---|---|');
    md.push(...uniformDiffLines);
    md.push('');
    md.push('## Geometry statistics (A vs B)');
    md.push('A: ' + JSON.stringify(stateA.geometryInfo, null, 2));
    md.push('B: ' + JSON.stringify(stateB.geometryInfo, null, 2));
    md.push('');
    md.push('## Renderer facts (A vs B)');
    md.push('A: ' + JSON.stringify(stateA.rendererFacts, null, 2));
    md.push('B: ' + JSON.stringify(stateB.rendererFacts, null, 2));
    md.push('');
    md.push('## GL records (A vs B)');
    md.push('A: ' + JSON.stringify(stateA.glRecords, null, 2));
    md.push('B: ' + JSON.stringify(stateB.glRecords, null, 2));
    md.push('');
    md.push('## Material flags (A vs B)');
    md.push('A: ' + JSON.stringify(stateA.materialFlags, null, 2));
    md.push('B: ' + JSON.stringify(stateB.materialFlags, null, 2));
    md.push('');
    md.push('## Scene graph (A vs B)');
    md.push('A: ' + JSON.stringify(stateA.sceneGraph, null, 2));
    md.push('B: ' + JSON.stringify(stateB.sceneGraph, null, 2));
    md.push('');
    md.push('## Controls (Scene leg only)');
    md.push('(a) u_peelLinear forced to 1: hasUniform=' + peelResult.hasUniform + (peelResult.hasUniform ? (', orig=' + JSON.stringify(peelResult.orig)) : '') + '. See control-a-peel1.png.');
    md.push('(b) i_tangent/i_bitangent replaced with per-triangle frames on a deindexed geometry copy (prepGeometry non-indexed algorithm): ok=' + tangentResult.ok + '. See control-b-recomputed-tangents.png.');
    md.push('');

    fs.writeFileSync(path.join(OUT_DIR, 'DIFF.md'), md.join('\n'), 'utf8');

    expect(stateA.fragmentShader).toBeTruthy();
    expect(stateB.fragmentShader).toBeTruthy();
  });
});
