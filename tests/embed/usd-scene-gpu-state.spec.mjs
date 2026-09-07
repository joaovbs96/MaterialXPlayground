// Opt-in headed GPU state dump: Scene vs Viewer, Rook black material.
// Collects shaders/uniforms/GL state from both pages and diffs them.
// Not part of any CI tier; set USD_CHESS_ROOT to run.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './lib/test-base.mjs';

const chessRoot = process.env.USD_CHESS_ROOT || '';
const rookRoot = chessRoot ? path.join(path.dirname(chessRoot), 'assets', 'Rook') : '';
const OUT_DIR = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\ab4';
fs.mkdirSync(OUT_DIR, { recursive: true });
const VIEWPORT = { width: 1400, height: 1100 };

// Runs inside the page. `which` picks the target material: 'scene' scans
// the Set of RawShaderMaterials for the Rook black nodegraph name; 'viewer'
// just reads the shaderball's current material off the debug handle.
function collectState(which) {
  /* eslint-disable no-undef */
  const handle = which === 'scene' ? window.__mtlxUsdSceneHandle : window.__mtlxViewerHandle;
  if (!handle || typeof handle.__debug !== 'function') return { available: false };
  const dbg = handle.__debug();
  const renderer = dbg.renderer;
  const scene = dbg.scene;
  let material = null;
  let mesh = null;
  if (which === 'scene') {
    for (const m of dbg.materials) {
      const p = (m.userData && m.userData.mtlxSceneMaterialPath) || '';
      if (/black/i.test(p) || /_B$/i.test(p)) { material = m; break; }
    }
  } else {
    material = dbg.material;
  }
  if (!material) {
    const dump = which === 'scene' ? dbg.materials.map((m) => ({ path: (m.userData && m.userData.mtlxSceneMaterialPath), src: (m.userData && m.userData.mtlxSceneSourceAsset), name: m.name })) : null;
    return { available: true, materialFound: false, dump };
  }
  scene.traverse((obj) => { if (obj.isMesh && obj.material === material) mesh = obj; });

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
        uuid: tex.uuid,
        isDataTexture: !!tex.isDataTexture,
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
        version: tex.version,
        mipmapsLength: (tex.mipmaps && tex.mipmaps.length) || 0,
        isDefault: window.samplerHoldsDefault ? window.samplerHoldsDefault({ value: tex }) : null,
        upload__version: props.__version !== undefined ? props.__version : null,
        upload__maxMipLevel: props.__maxMipLevel !== undefined ? props.__maxMipLevel : null,
        hasWebglTexture: !!props.__webglTexture,
        __webglTextureRef: props.__webglTexture || null,
      };
    }
    if (typeof v.toArray === 'function') return { __kind: 'vecOrMat', values: v.toArray() };
    return { __kind: 'object', keys: Object.keys(v) };
  };

  const uniforms = {};
  const glRecords = {};
  for (const name of Object.keys(material.uniforms || {})) {
    const entry = material.uniforms[name];
    uniforms[name] = serializeValue(entry ? entry.value : undefined);
  }

  // GL-level facts for env radiance/irradiance samplers.
  const gl = renderer.getContext();
  const anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
  for (const name of Object.keys(material.uniforms || {})) {
    if (!/env(Radiance|Irradiance)/i.test(name)) continue;
    const tex = material.uniforms[name].value;
    if (!isTextureLike(tex)) continue;
    const props = renderer.properties.get(tex) || {};
    const webglTex = props.__webglTexture;
    if (!webglTex) { glRecords[name] = { hasWebglTexture: false }; continue; }
    const prevBinding = gl.getParameter(gl.TEXTURE_BINDING_2D);
    gl.bindTexture(gl.TEXTURE_2D, webglTex);
    glRecords[name] = {
      TEXTURE_MIN_FILTER: gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER),
      TEXTURE_MAG_FILTER: gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER),
      TEXTURE_WRAP_S: gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S),
      TEXTURE_WRAP_T: gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T),
      TEXTURE_MAX_LEVEL: gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL),
      TEXTURE_BASE_LEVEL: gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL),
      anisotropy: anisoExt ? gl.getTexParameter(gl.TEXTURE_2D, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT) : null,
    };
    gl.bindTexture(gl.TEXTURE_2D, prevBinding);
  }

  // Active-uniform list from the compiled program, if we can find it.
  let activeUniforms = null;
  try {
    const programRecord = renderer.properties.get(material).currentProgram || renderer.properties.get(material).program;
    const program = programRecord && programRecord.program;
    if (program) {
      const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      activeUniforms = [];
      for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(program, i);
        if (info) activeUniforms.push({ name: info.name, type: info.type, size: info.size });
      }
    }
  } catch (e) { activeUniforms = 'error: ' + String(e); }

  const rendererFacts = {
    isWebGL2: renderer.capabilities.isWebGL2,
    maxTextures: renderer.capabilities.maxTextures,
    precision: renderer.capabilities.precision,
    hasColorBufferFloat: !!renderer.extensions.get('EXT_color_buffer_float'),
    outputEncoding: renderer.outputEncoding,
    toneMapping: renderer.toneMapping,
    toneMappingExposure: renderer.toneMappingExposure,
    pixelRatio: renderer.getPixelRatio(),
    activeUniforms,
  };

  const materialFlags = {
    side: material.side,
    transparent: material.transparent,
    depthWrite: material.depthWrite,
    blending: material.blending,
    glslVersion: material.glslVersion,
    defines: material.defines,
    extensions: material.extensions,
    premultipliedAlpha: material.premultipliedAlpha,
    toneMapped: material.toneMapped,
  };

  let geometryInfo = null;
  if (mesh && mesh.geometry) {
    const g = mesh.geometry;
    const attrs = {};
    for (const name of Object.keys(g.attributes)) {
      const a = g.attributes[name];
      attrs[name] = { itemSize: a.itemSize, count: a.count };
    }
    geometryInfo = { attributes: attrs, hasIndex: !!g.index, indexCount: g.index ? g.index.count : null };
  }

  return {
    available: true,
    materialFound: true,
    fragmentShader: material.fragmentShader,
    vertexShader: material.vertexShader,
    uniforms,
    glRecords,
    rendererFacts,
    materialFlags,
    geometryInfo,
  };
  /* eslint-enable no-undef */
}

function normalizeShader(src) {
  return (src || '').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

// Minimal LCS-based unified-ish line diff, good enough for a lead list.
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

test.describe('@scene GPU state diagnosis (opt-in)', () => {
  test.skip(!chessRoot, 'Set USD_CHESS_ROOT to run this diagnostic.');

  test('collect Scene and Viewer GPU state for the Rook black material and diff', async ({ page, embedURL }) => {
    test.setTimeout(300000);
    await page.setViewportSize(VIEWPORT);

    // --- Scene leg ---
    await page.goto(embedURL + '/index.html#!scene');
    await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
    await page.locator('input[type=file][webkitdirectory]').setInputFiles(rookRoot);
    await expect(page.getByTestId('usd-scene-root-select')).toBeVisible({ timeout: 30000 });
    const rootCombobox = page.getByTestId('usd-scene-root-select').getByRole('combobox');
    if (await rootCombobox.count()) {
      await rootCombobox.click();
      const options = await page.getByRole('option').allTextContents();
      const selected = options.find((l) => l.endsWith('/Rook.usd') || l === 'Rook.usd');
      await page.getByRole('option', { name: selected, exact: true }).click();
    }
    await page.getByTestId('usd-scene-sidebar').getByRole('button', { name: /^Load (?!example)/ }).click();
    await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 180000 });
    await page.waitForTimeout(800);

    const sceneState = await page.evaluate(collectState, 'scene');
    fs.writeFileSync(path.join(OUT_DIR, 'scene-fragment.txt'), sceneState.fragmentShader || '', 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'scene-vertex.txt'), sceneState.vertexShader || '', 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'scene-state.json'), JSON.stringify(sceneState, null, 2), 'utf8');

    // Mips experiment on the Scene leg.
    const mipsUniformName = await page.evaluate(() => {
      const h = window.__mtlxUsdSceneHandle;
      const dbg = h.__debug();
      for (const m of dbg.materials) {
        if ((m.userData && /black/i.test(m.userData.mtlxSceneMaterialPath || '') || /_B$/i.test(m.userData.mtlxSceneMaterialPath || ''))) {
          for (const name of Object.keys(m.uniforms)) if (/envRadianceMips|u_envRadianceMips/i.test(name)) return name;
        }
      }
      return null;
    });
    const notes = [];
    notes.push('Scene mips uniform found: ' + mipsUniformName);
    if (mipsUniformName) {
      const orig = await page.evaluate((name) => {
        const h = window.__mtlxUsdSceneHandle;
        const dbg = h.__debug();
        for (const m of dbg.materials) {
          if ((m.userData && /black/i.test(m.userData.mtlxSceneMaterialPath || '') || /_B$/i.test(m.userData.mtlxSceneMaterialPath || ''))) {
            const v = m.uniforms[name].value;
            m.uniforms[name].value = 1;
            dbg.renderer.render(dbg.scene, dbg.camera);
            return v;
          }
        }
        return null;
      }, mipsUniformName);
      await page.getByTestId('usd-scene-canvas').screenshot({ path: path.join(OUT_DIR, 'scene-mips-1.png') });
      await page.evaluate((args) => {
        const [name, v] = args;
        const h = window.__mtlxUsdSceneHandle;
        const dbg = h.__debug();
        for (const m of dbg.materials) {
          if ((m.userData && /black/i.test(m.userData.mtlxSceneMaterialPath || '') || /_B$/i.test(m.userData.mtlxSceneMaterialPath || ''))) {
            m.uniforms[name].value = v;
            dbg.renderer.render(dbg.scene, dbg.camera);
          }
        }
      }, [mipsUniformName, orig]);
      await page.getByTestId('usd-scene-canvas').screenshot({ path: path.join(OUT_DIR, 'scene-mips-restored.png') });
      notes.push('Scene mips forced to 1 then restored to ' + JSON.stringify(orig) + '; see scene-mips-1.png vs scene-mips-restored.png');
    }
    const samplesUniformName = await page.evaluate(() => {
      const h = window.__mtlxUsdSceneHandle;
      const dbg = h.__debug();
      for (const m of dbg.materials) {
        if ((m.userData && /black/i.test(m.userData.mtlxSceneMaterialPath || '') || /_B$/i.test(m.userData.mtlxSceneMaterialPath || ''))) {
          for (const name of Object.keys(m.uniforms)) if (/envRadianceSamples|u_envRadianceSamples/i.test(name)) return name;
        }
      }
      return null;
    });
    notes.push('Scene samples uniform found: ' + samplesUniformName);
    if (samplesUniformName) {
      await page.evaluate((name) => {
        const h = window.__mtlxUsdSceneHandle;
        const dbg = h.__debug();
        for (const m of dbg.materials) {
          if ((m.userData && /black/i.test(m.userData.mtlxSceneMaterialPath || '') || /_B$/i.test(m.userData.mtlxSceneMaterialPath || ''))) {
            m.uniforms[name].value = 64;
            dbg.renderer.render(dbg.scene, dbg.camera);
          }
        }
      }, samplesUniformName);
      await page.getByTestId('usd-scene-canvas').screenshot({ path: path.join(OUT_DIR, 'scene-samples-64.png') });
      notes.push('Scene samples forced to 64; see scene-samples-64.png');
    }

    // --- Viewer leg ---
    const consoleMsgs = [];
    page.on('console', (m) => consoleMsgs.push(m.text()));
    await page.goto(embedURL + '/index.html#!viewer');
    const dirInputCount = await page.locator('input[type=file][webkitdirectory]').count();
    fs.writeFileSync(path.join(OUT_DIR, 'DEBUG-dirinput-count.txt'), String(dirInputCount), 'utf8');
    // Let the auto-loaded default material's fetch+ingest fully settle first,
    // so the folder drop below deterministically hits the REPLACE branch.
    await page.waitForFunction(() => !document.body.innerText.includes('Generating shader'), { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.locator('input[type=file][webkitdirectory]').first().setInputFiles(rookRoot);
    await page.waitForFunction(() => !document.body.innerText.includes('Generating shader'), { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.waitForFunction(() => !!window.__mtlxViewerHandle, { timeout: 20000 }).catch(() => {});
    await page.locator('canvas').first().screenshot({ path: path.join(OUT_DIR, 'DEBUG-viewer-after-load.png') });
    fs.writeFileSync(path.join(OUT_DIR, 'DEBUG-console.txt'), consoleMsgs.join('\n'), 'utf8');
    const bottomLeftText = await page.evaluate(() => document.body.innerText.slice(-2000));
    fs.writeFileSync(path.join(OUT_DIR, 'DEBUG-bodytext.txt'), bottomLeftText, 'utf8');

    // Pick the black Rook material if a selector is present.
    const matOptionButtons = page.locator('[role="combobox"]');
    const matSelect = matOptionButtons.filter({ hasText: /./ });
    try {
      const combo = page.locator('text=Materials').locator('..').getByRole('combobox');
      if (await combo.count()) {
        await combo.first().click();
        const opts = await page.getByRole('option').allTextContents();
        const blackOpt = opts.find((o) => /black/i.test(o)) || opts[0];
        if (blackOpt) await page.getByRole('option', { name: blackOpt, exact: true }).click();
        await page.waitForFunction(() => !document.body.innerText.includes('Generating shader'), { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    } catch (e) { notes.push('Viewer material selector not found or not needed: ' + String(e)); }

    const viewerState = await page.evaluate(collectState, 'viewer');
    fs.writeFileSync(path.join(OUT_DIR, 'viewer-fragment.txt'), viewerState.fragmentShader || '', 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'viewer-vertex.txt'), viewerState.vertexShader || '', 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'viewer-state.json'), JSON.stringify(viewerState, null, 2), 'utf8');

    // Viewer mips experiment: force the same uniform to 0 if present.
    const viewerMipsUniform = mipsUniformName && viewerState.uniforms && Object.prototype.hasOwnProperty.call(viewerState.uniforms, mipsUniformName)
      ? mipsUniformName : null;
    if (viewerMipsUniform) {
      await page.evaluate((name) => {
        const h = window.__mtlxViewerHandle;
        const dbg = h.__debug();
        dbg.material.uniforms[name].value = 0;
        dbg.renderer.render(dbg.scene, dbg.camera);
      }, viewerMipsUniform);
      await page.locator('canvas').first().screenshot({ path: path.join(OUT_DIR, 'viewer-mips-0.png') });
      notes.push('Viewer mips uniform ' + viewerMipsUniform + ' forced to 0; see viewer-mips-0.png (compare by eye against scene-mips-1.png / original Viewer look)');
    } else {
      notes.push('Viewer material has no ' + mipsUniformName + ' uniform to test');
    }

    // --- Diff ---
    const fragDiff = lineDiff(normalizeShader(sceneState.fragmentShader), normalizeShader(viewerState.fragmentShader));
    const vertDiff = lineDiff(normalizeShader(sceneState.vertexShader), normalizeShader(viewerState.vertexShader));

    const uniformDiffLines = [];
    const allNames = new Set([...Object.keys(sceneState.uniforms || {}), ...Object.keys(viewerState.uniforms || {})]);
    for (const name of allNames) {
      const a = JSON.stringify(sceneState.uniforms ? sceneState.uniforms[name] : undefined);
      const b = JSON.stringify(viewerState.uniforms ? viewerState.uniforms[name] : undefined);
      if (a !== b) uniformDiffLines.push('| ' + name + ' | ' + (a || '(missing)') + ' | ' + (b || '(missing)') + ' |');
    }

    const md = [];
    md.push('# Scene vs Viewer GPU state diff (Rook black material)');
    md.push('');
    md.push('Scene material found: ' + sceneState.materialFound + ', Viewer material found: ' + viewerState.materialFound);
    md.push('');
    md.push('## Fragment shader diff (normalized whitespace, ' + fragDiff.length + ' differing lines)');
    md.push('```diff');
    md.push(...fragDiff.slice(0, 400));
    if (fragDiff.length > 400) md.push('... truncated, ' + (fragDiff.length - 400) + ' more lines, see full sources in scene-fragment.txt / viewer-fragment.txt');
    md.push('```');
    md.push('');
    md.push('## Vertex shader diff (normalized whitespace, ' + vertDiff.length + ' differing lines)');
    md.push('```diff');
    md.push(...vertDiff.slice(0, 400));
    if (vertDiff.length > 400) md.push('... truncated, ' + (vertDiff.length - 400) + ' more lines, see full sources in scene-vertex.txt / viewer-vertex.txt');
    md.push('```');
    md.push('');
    md.push('## Differing uniforms');
    md.push('| name | scene | viewer |');
    md.push('|---|---|---|');
    md.push(...uniformDiffLines);
    md.push('');
    md.push('## GL records (env samplers)');
    md.push('Scene: ' + JSON.stringify(sceneState.glRecords, null, 2));
    md.push('Viewer: ' + JSON.stringify(viewerState.glRecords, null, 2));
    md.push('');
    md.push('## Renderer facts');
    md.push('Scene: ' + JSON.stringify(sceneState.rendererFacts, null, 2));
    md.push('Viewer: ' + JSON.stringify(viewerState.rendererFacts, null, 2));
    md.push('');
    md.push('## Material flags');
    md.push('Scene: ' + JSON.stringify(sceneState.materialFlags, null, 2));
    md.push('Viewer: ' + JSON.stringify(viewerState.materialFlags, null, 2));
    md.push('');
    md.push('## Geometry');
    md.push('Scene: ' + JSON.stringify(sceneState.geometryInfo, null, 2));
    md.push('Viewer: ' + JSON.stringify(viewerState.geometryInfo, null, 2));
    md.push('');
    md.push('## Mips / samples experiment notes');
    for (const n of notes) md.push('- ' + n);
    md.push('');

    fs.writeFileSync(path.join(OUT_DIR, 'DIFF.md'), md.join('\n'), 'utf8');

    expect(sceneState.materialFound).toBeTruthy();
    expect(viewerState.materialFound).toBeTruthy();
  });
});
