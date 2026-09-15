// tests/embed/accumulation.spec.mjs: progressive jittered-frame
// accumulation (js/mtlx-engine.js createFrameAccumulator + the
// createMtlxRenderView animate() integration). Covers the settings API,
// the jitter sequence, convergence/no-further-draws, the RawShaderMaterial
// encoding proof (a jitter-0 sample matches the direct canvas frame),
// snapshot({accumulated:true}), the reset sources, and Force Transparency
// interop. Runs on the default SwiftShader config.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

// Plain opaque standard_surface: no textures, so the directory upload is
// a single file and the sphere silhouette covers the whole metric box.
const OPAQUE_MTLX = `<?xml version="1.0"?>
<materialx version="1.39" colorspace="lin_rec709">
  <standard_surface name="SR_accum" type="surfaceshader">
    <input name="base" type="float" value="0.8" />
    <input name="base_color" type="color3" value="0.6, 0.2, 0.2" />
    <input name="specular_roughness" type="float" value="0.3" />
  </standard_surface>
  <surfacematerial name="AccumMat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="SR_accum" />
  </surfacematerial>
</materialx>`;

// Zero specular: no grazing-angle Fresnel rim, so a silhouette pixel's
// color stays close to the flat interior color regardless of viewing
// angle. Used only where a test needs to compare edge color against
// interior color without that legitimate shading gradient confounding it.
const FLAT_MTLX = `<?xml version="1.0"?>
<materialx version="1.39" colorspace="lin_rec709">
  <standard_surface name="SR_accum_flat" type="surfaceshader">
    <input name="base" type="float" value="0.8" />
    <input name="base_color" type="color3" value="0.6, 0.2, 0.2" />
    <input name="specular" type="float" value="0.0" />
  </standard_surface>
  <surfacematerial name="FlatMat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="SR_accum_flat" />
  </surfacematerial>
</materialx>`;

const GLASS_MTLX = `<?xml version="1.0"?>
<materialx version="1.39" colorspace="lin_rec709">
  <standard_surface name="SR_accum_glass" type="surfaceshader">
    <input name="base" type="float" value="0.0" />
    <input name="specular" type="float" value="1" />
    <input name="specular_color" type="color3" value="1, 1, 1" />
    <input name="specular_roughness" type="float" value="0.05" />
    <input name="transmission" type="float" value="1" />
    <input name="transmission_color" type="color3" value="1, 1, 1" />
  </standard_surface>
  <surfacematerial name="AccumGlass" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="SR_accum_glass" />
  </surfacematerial>
</materialx>`;

// Static (no u_time) high-frequency fractal3d noise driving base_color,
// object-space position scaled way up so it aliases hard at sphere/
// screen resolution: same class of per-pixel speckle as Stirling's flake
// noise. Pattern lifted from examples/animated_noise.mtlx minus the
// time-based scroll (an animated material never accumulates at all).
const NOISE_MTLX = `<?xml version="1.0"?>
<materialx version="1.39" colorspace="lin_rec709">
  <nodegraph name="NG_accum_noise">
    <position name="pos" type="vector3">
      <input name="space" type="string" value="object" />
    </position>
    <multiply name="scaledpos" type="vector3">
      <input name="in1" type="vector3" nodename="pos" />
      <input name="in2" type="float" value="400.0" />
    </multiply>
    <fractal3d name="noise" type="float">
      <input name="position" type="vector3" nodename="scaledpos" />
      <input name="amplitude" type="float" value="1.0" />
      <input name="octaves" type="integer" value="3" />
    </fractal3d>
    <remap name="noise01" type="float">
      <input name="in" type="float" nodename="noise" />
      <input name="inlow" type="float" value="-1.0" />
      <input name="inhigh" type="float" value="1.0" />
      <input name="outlow" type="float" value="0.0" />
      <input name="outhigh" type="float" value="1.0" />
    </remap>
    <convert name="noisecol" type="color3">
      <input name="in" type="float" nodename="noise01" />
    </convert>
    <output name="out" type="color3" nodename="noisecol" />
  </nodegraph>
  <standard_surface name="SR_accum_noise" type="surfaceshader">
    <input name="base" type="float" value="1.0" />
    <input name="base_color" type="color3" nodegraph="NG_accum_noise" output="out" />
    <input name="specular" type="float" value="0.0" />
  </standard_surface>
  <surfacematerial name="NoiseMat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="SR_accum_noise" />
  </surfacematerial>
</materialx>`;

// Opens #!viewer, drops a one-file directory containing `mtlxText`, waits
// for it to render, and returns { context, page } with
// window.__mtlxViewerHandle live. A fresh context per call, same
// rationale as heighttonormal.spec.mjs: settings read from localStorage
// at module load must not leak between conditions.
async function loadSphereView(browser, embedURL, mtlxText, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtlx-accum-spec-'));
  fs.writeFileSync(path.join(dir, 'accumtest.mtlx'), mtlxText);
  const context = await browser.newContext();
  const page = await context.newPage();
  if (opts.initScript) await page.addInitScript(opts.initScript, opts.initArg);
  try {
    const url = embedURL + '/index.html' + (opts.query || '') + '#!viewer';
    await page.goto(url);
    const dirInput = page.locator('input[type=file][webkitdirectory]').first();
    await dirInput.waitFor({ state: 'attached', timeout: WAIT_TIMEOUT });
    await page.evaluate((g) => window.setGlobalGeom && window.setGlobalGeom(g), opts.geom || 'sphere');
    await page.waitForTimeout(150);
    await dirInput.setInputFiles(dir);
    await expect(page.getByText('1 .mtlx', { exact: false })).toBeVisible({ timeout: WAIT_TIMEOUT });
    await expect.poll(() => page.evaluate(() => !!(window.__mtlxViewerHandle && window.__mtlxViewerHandle.getAccumulationState)),
      { timeout: WAIT_TIMEOUT }).toBe(true);
    return { context, page };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('accumulation=0 URL param seeds off without writing localStorage; setter persists and fires the event', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html?accumulation=0#!viewer');
  await page.locator('input[type=file][webkitdirectory]').first().waitFor({ state: 'attached', timeout: WAIT_TIMEOUT });

  const seeded = await page.evaluate(() => window.getAccumulationEnabled());
  expect(seeded).toBe(false);
  const stored = await page.evaluate(() => localStorage.getItem('mtlxAccumulation'));
  expect(stored).toBeNull();

  const eventValue = await page.evaluate(() => new Promise((resolve) => {
    const onChanged = (e) => {
      if (!e.detail || e.detail.key !== 'accumulation') return;
      window.removeEventListener('mtlx-settings-changed', onChanged);
      resolve(e.detail.value);
    };
    window.addEventListener('mtlx-settings-changed', onChanged);
    window.setAccumulationEnabled(true);
  }));
  expect(eventValue).toBe(true);
  const storedAfter = await page.evaluate(() => localStorage.getItem('mtlxAccumulation'));
  expect(storedAfter).toBe('1');
});

test('accumulationJitter(0) is zero, 1..31 are distinct and inside [-0.5, 0.5]', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!viewer');
  await page.locator('input[type=file][webkitdirectory]').first().waitFor({ state: 'attached', timeout: WAIT_TIMEOUT });

  const pts = await page.evaluate(() => {
    const out = [];
    for (let i = 0; i < 32; i++) out.push(window.accumulationJitter(i));
    return out;
  });
  expect(pts[0]).toEqual({ x: 0, y: 0 });
  const seen = new Set();
  for (let i = 1; i < 32; i++) {
    const p = pts[i];
    expect(p.x).toBeGreaterThanOrEqual(-0.5);
    expect(p.x).toBeLessThanOrEqual(0.5);
    expect(p.y).toBeGreaterThanOrEqual(-0.5);
    expect(p.y).toBeLessThanOrEqual(0.5);
    const key = p.x.toFixed(9) + ',' + p.y.toFixed(9);
    expect(seen.has(key)).toBe(false);
    seen.add(key);
  }
});

test('a still sphere view converges to 32 samples and stops drawing', async ({ browser, embedURL }) => {
  const { context, page } = await loadSphereView(browser, embedURL, OPAQUE_MTLX);
  try {
    await expect.poll(() => page.evaluate(() => window.__mtlxViewerHandle.getAccumulationState()),
      { timeout: WAIT_TIMEOUT }).toMatchObject({ samples: 32, converged: true, reason: null });

    const frameBefore = await page.evaluate(() => window.__mtlxViewerHandle.renderer.info.render.frame);
    await page.waitForTimeout(500);
    const frameAfter = await page.evaluate(() => window.__mtlxViewerHandle.renderer.info.render.frame);
    expect(frameAfter).toBe(frameBefore);
  } finally {
    await context.close();
  }
});

// Compare's 200ms stats/diff ticker calls snapshotPixels() continuously,
// which internally draws an unjittered direct frame. Without
// restoreAccumulatedPresentation() the visible canvas would be left
// showing that direct frame instead of the averaged image; checked
// within the same browser turn as the calls (matching how a caller
// reads the canvas element right after invoking these), since the
// canvas only ever holds one live drawing-buffer snapshot at a time.
test('snapshotPixels re-presents the accumulated average instead of stranding the direct frame', async ({ browser, embedURL }) => {
  const { context, page } = await loadSphereView(browser, embedURL, OPAQUE_MTLX);
  try {
    await expect.poll(() => page.evaluate(() => window.__mtlxViewerHandle.getAccumulationState()),
      { timeout: WAIT_TIMEOUT }).toMatchObject({ samples: 32, converged: true });

    const [accUrl, canvasUrl] = await page.evaluate(() => {
      const h = window.__mtlxViewerHandle;
      const acc = h.snapshot({ accumulated: true });
      // Mimic the diff ticker: several plain unjittered readbacks in a
      // row, then read the canvas as-is (no further render call).
      for (let i = 0; i < 3; i++) h.snapshotPixels(64, 64);
      return [acc, h.renderer.domElement.toDataURL('image/png')];
    });
    const acc = decodePNG(Buffer.from(accUrl.split(',')[1], 'base64'));
    const canvas = decodePNG(Buffer.from(canvasUrl.split(',')[1], 'base64'));
    expect(canvas.width).toBe(acc.width);
    expect(canvas.height).toBe(acc.height);

    const box = Math.floor(Math.min(acc.width, acc.height) * 0.25);
    const x0 = Math.floor((acc.width - box) / 2), y0 = Math.floor((acc.height - box) / 2);
    let sum = 0, n = 0;
    for (let y = y0; y < y0 + box; y++) {
      for (let x = x0; x < x0 + box; x++) {
        const a = acc.getPixel(x, y), b = canvas.getPixel(x, y);
        sum += Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
        n += 3;
      }
    }
    expect(sum / n).toBeLessThanOrEqual(1);
  } finally {
    await context.close();
  }
});

// The encoding proof: a jitter-0 sample rendered through the accumulator
// (offscreen target, then present()'d back) must match the same frame
// drawn straight to the canvas, since RawShaderMaterial fragment shaders
// skip three.js's own output-encoding/tone-mapping chunk regardless of
// which target is bound (verified against vendor/three/three.min.js).
// Compared on an interior box only: the direct path renders through the
// canvas's own MSAA, so silhouette pixels legitimately differ.
test('a jitter-0 accumulated sample matches the direct canvas frame within 1/255 (interior pixels)', async ({ browser, embedURL }) => {
  const { context, page } = await loadSphereView(browser, embedURL, OPAQUE_MTLX);
  try {
    const result = await page.evaluate(() => {
      const h = window.__mtlxViewerHandle;
      const { renderer, camera } = h.__debug();
      const canvas = renderer.domElement;
      const w = canvas.width, ht = canvas.height;
      const readInteriorBox = () => {
        const box = Math.floor(Math.min(w, ht) * 0.3);
        const x0 = Math.floor((w - box) / 2), y0 = Math.floor((ht - box) / 2);
        const c = document.createElement('canvas'); c.width = box; c.height = box;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(canvas, x0, y0, box, box, 0, 0, box, box);
        return ctx.getImageData(0, 0, box, box).data;
      };

      h.renderNow();
      const direct = readInteriorBox();

      const acc = window.createFrameAccumulator(renderer);
      const jitter = acc.beginSample();
      try {
        if (camera.setViewOffset) camera.setViewOffset(w, ht, jitter.x, jitter.y, w, ht);
        h.renderNow();
      } finally {
        if (camera.clearViewOffset) camera.clearViewOffset();
      }
      acc.endSample();
      acc.present();
      const accumulated = readInteriorBox();
      acc.dispose();
      h.invalidateAccumulation();

      let maxDiff = 0;
      for (let i = 0; i < direct.length; i++) maxDiff = Math.max(maxDiff, Math.abs(direct[i] - accumulated[i]));
      return { maxDiff, jitter };
    });
    expect(result.jitter).toEqual({ x: 0, y: 0 });
    expect(result.maxDiff).toBeLessThanOrEqual(1);
  } finally {
    await context.close();
  }
});

test('snapshot({accumulated:true}) differs from snapshot() mainly near silhouette edges', async ({ browser, embedURL }) => {
  const { context, page } = await loadSphereView(browser, embedURL, OPAQUE_MTLX);
  try {
    const [directUrl, accUrl] = await page.evaluate(() => {
      const h = window.__mtlxViewerHandle;
      return [h.snapshot(), h.snapshot({ accumulated: true })];
    });
    const direct = decodePNG(Buffer.from(directUrl.split(',')[1], 'base64'));
    const accumulated = decodePNG(Buffer.from(accUrl.split(',')[1], 'base64'));
    expect(accumulated.width).toBe(direct.width);
    expect(accumulated.height).toBe(direct.height);

    const box = Math.floor(Math.min(direct.width, direct.height) * 0.25);
    const x0 = Math.floor((direct.width - box) / 2), y0 = Math.floor((direct.height - box) / 2);
    let interiorSum = 0, interiorN = 0;
    for (let y = y0; y < y0 + box; y++) {
      for (let x = x0; x < x0 + box; x++) {
        const a = direct.getPixel(x, y), b = accumulated.getPixel(x, y);
        interiorSum += Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
        interiorN += 3;
      }
    }
    expect(interiorSum / interiorN).toBeLessThanOrEqual(2);

    // Some pixel somewhere (the silhouette, under AA) must have changed
    // meaningfully, proving accumulation actually did something.
    let maxDiff = 0;
    for (let y = 0; y < direct.height; y++) {
      for (let x = 0; x < direct.width; x++) {
        const a = direct.getPixel(x, y), b = accumulated.getPixel(x, y);
        maxDiff = Math.max(maxDiff, Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
      }
    }
    expect(maxDiff).toBeGreaterThan(2);
  } finally {
    await context.close();
  }
});

test('camera orbit and a uniform poke reset accumulation; disabling gives reason disabled', async ({ browser, embedURL }) => {
  const { context, page } = await loadSphereView(browser, embedURL, OPAQUE_MTLX);
  try {
    await expect.poll(() => page.evaluate(() => window.__mtlxViewerHandle.getAccumulationState()),
      { timeout: WAIT_TIMEOUT }).toMatchObject({ samples: 32, converged: true });

    // Camera move: within one frame, samples must drop well below 32.
    await page.evaluate(() => window.__mtlxViewerHandle.setCamera({ position: [3, 1.5, 3] }));
    await page.waitForTimeout(80);
    const afterOrbit = await page.evaluate(() => window.__mtlxViewerHandle.getAccumulationState());
    expect(afterOrbit.samples).toBeLessThan(32);

    // Let it reconverge, then poke a numeric uniform directly (mirrors
    // the Graph Editor's tryFastUniformUpdate).
    await expect.poll(() => page.evaluate(() => window.__mtlxViewerHandle.getAccumulationState()),
      { timeout: WAIT_TIMEOUT }).toMatchObject({ samples: 32, converged: true });
    await page.evaluate(() => {
      const h = window.__mtlxViewerHandle;
      const u = h.uniforms;
      const key = Object.keys(u).find((k) => k.indexOf('base_color') !== -1 || k.indexOf('specular_roughness') !== -1);
      if (key && typeof u[key].value === 'number') u[key].value += 0.01;
      else if (key && u[key].value && typeof u[key].value.x === 'number') u[key].value.x += 0.01;
    });
    await page.waitForTimeout(80);
    const afterPoke = await page.evaluate(() => window.__mtlxViewerHandle.getAccumulationState());
    expect(afterPoke.samples).toBeLessThan(32);

    // Turn the setting off: reason must read 'disabled'.
    await page.evaluate(() => window.setAccumulationEnabled(false));
    await page.waitForTimeout(80);
    const disabled = await page.evaluate(() => window.__mtlxViewerHandle.getAccumulationState());
    expect(disabled.enabled).toBe(false);
    expect(disabled.reason).toBe('disabled');
    expect(disabled.samples).toBe(0);
  } finally {
    await context.close();
  }
});

test('Force Transparency on: accumulation still converges and the snapshot is not black', async ({ browser, embedURL }) => {
  const { context, page } = await loadSphereView(browser, embedURL, GLASS_MTLX);
  try {
    await page.evaluate(() => window.setForceTransparency && window.setForceTransparency(true));
    await page.waitForTimeout(200);
    await expect.poll(() => page.evaluate(() => window.__mtlxViewerHandle.getAccumulationState()),
      { timeout: WAIT_TIMEOUT }).toMatchObject({ samples: 32, converged: true });

    const dataUrl = await page.evaluate(() => window.__mtlxViewerHandle.snapshot());
    const png = decodePNG(Buffer.from(dataUrl.split(',')[1], 'base64'));
    const center = png.getPixel(Math.floor(png.width / 2), Math.floor(png.height / 2));
    expect(center.r + center.g + center.b).toBeGreaterThan(10);
  } finally {
    await context.close();
  }
});

// Regression for the accumulator darkening every non-raw three.js
// material (studio backdrop/floor, shaderball-scene's neutral glTF
// parts: MeshStandard/MeshBasic, toneMapped). Those pick their output
// encoding from the BOUND render target's texture.encoding when one is
// bound, not renderer.outputEncoding (WebGLPrograms getParameters,
// vendor/three/three.min.js); left at the WebGLRenderTarget default
// (LinearEncoding) this silently dropped their sRGB encode inside the
// accumulator's offscreen sample target. The MaterialX RawShaderMaterial
// surface itself is unaffected either way (it does its own encoding in
// GLSL and skips three's encodings chunk), which is why the plain
// sphere/interior checks elsewhere in this file never caught this.
test('shaderball-scene studio backdrop is not darkened by accumulation', async ({ browser, embedURL }) => {
  const { context, page } = await loadSphereView(browser, embedURL, OPAQUE_MTLX, { geom: 'shaderball-scene' });
  try {
    await expect.poll(() => page.evaluate(() => window.__mtlxViewerHandle.getAccumulationState()),
      { timeout: WAIT_TIMEOUT }).toMatchObject({ samples: 32, converged: true });

    const [directUrl, accUrl] = await page.evaluate(() => {
      const h = window.__mtlxViewerHandle;
      return [h.snapshot(), h.snapshot({ accumulated: true })];
    });
    const direct = decodePNG(Buffer.from(directUrl.split(',')[1], 'base64'));
    const accumulated = decodePNG(Buffer.from(accUrl.split(',')[1], 'base64'));
    expect(accumulated.width).toBe(direct.width);
    expect(accumulated.height).toBe(direct.height);

    const meanAbsDiff = (x0, y0, boxW, boxH) => {
      let sum = 0, n = 0;
      for (let y = y0; y < y0 + boxH; y++) {
        for (let x = x0; x < x0 + boxW; x++) {
          const a = direct.getPixel(x, y), b = accumulated.getPixel(x, y);
          sum += Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
          n += 3;
        }
      }
      return sum / n;
    };

    // Backdrop-only box in a corner: far from the shaderball's own
    // silhouette (so no edge-AA pixels) and far from the MaterialX
    // surface itself, pure studio-room/glTF built-in material.
    const cornerBox = Math.max(8, Math.floor(Math.min(direct.width, direct.height) * 0.08));
    expect(meanAbsDiff(4, 4, cornerBox, cornerBox)).toBeLessThanOrEqual(2);

    // The MaterialX surface's own interior box still holds too.
    const ibox = Math.floor(Math.min(direct.width, direct.height) * 0.12);
    expect(meanAbsDiff(Math.floor((direct.width - ibox) / 2), Math.floor((direct.height - ibox) / 2), ibox, ibox))
      .toBeLessThanOrEqual(2);
  } finally {
    await context.close();
  }
});

// Regression: animate()/snapshot()'s per-sample loop called setUniforms()
// (which bakes u_viewProjectionMatrix/u_viewPosition into the MaterialX
// RawShaderMaterial's plain-JS uniforms object) BEFORE camera.setViewOffset(),
// and renderFrame() never refreshed them, so every "jittered" sample was
// actually identical for the MaterialX surface (built-in three materials
// read camera.projectionMatrix live at draw time, so THEY jittered fine,
// masking the bug on any scene with a backdrop). Isolated here with a
// view whose ONLY geometry is the MaterialX mesh itself (no backdrop).

// Fraction of pixels, inside a centered box, whose value differs from
// their own 3x3-neighborhood mean by more than `threshold` levels (any
// channel) - same speckle metric as heighttonormal.spec.mjs.
function speckleFraction(png, x0, y0, boxSize, threshold) {
  let speckled = 0, total = 0;
  for (let y = y0 + 1; y < y0 + boxSize - 1; y++) {
    for (let x = x0 + 1; x < x0 + boxSize - 1; x++) {
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const p = png.getPixel(x + dx, y + dy);
          sr += p.r; sg += p.g; sb += p.b; n++;
        }
      }
      const p = png.getPixel(x, y);
      const dr = Math.abs(p.r - sr / n), dg = Math.abs(p.g - sg / n), db = Math.abs(p.b - sb / n);
      total++;
      if (Math.max(dr, dg, db) > threshold) speckled++;
    }
  }
  return total ? speckled / total : 0;
}

test('accumulation smooths a high-frequency procedural material (not just built-in materials)', async ({ browser, embedURL }) => {
  const { context, page } = await loadSphereView(browser, embedURL, NOISE_MTLX, { geom: 'sphere' });
  try {
    await page.evaluate(() => {
      const h = window.__mtlxViewerHandle;
      if (h.setBackdrop) h.setBackdrop('none');
      if (h.setAutoRotate) h.setAutoRotate(false);
    });
    await page.waitForTimeout(300);
    await expect.poll(() => page.evaluate(() => window.__mtlxViewerHandle.getAccumulationState()),
      { timeout: WAIT_TIMEOUT }).toMatchObject({ samples: 32, converged: true });

    const [directUrl, accUrl] = await page.evaluate(() => {
      const h = window.__mtlxViewerHandle;
      return [h.snapshot(), h.snapshot({ accumulated: true })];
    });
    const direct = decodePNG(Buffer.from(directUrl.split(',')[1], 'base64'));
    const accumulated = decodePNG(Buffer.from(accUrl.split(',')[1], 'base64'));

    const box = Math.floor(Math.min(direct.width, direct.height) * 0.3);
    const x0 = Math.floor((direct.width - box) / 2), y0 = Math.floor((direct.height - box) / 2);
    const directFraction = speckleFraction(direct, x0, y0, box, 6);
    const accFraction = speckleFraction(accumulated, x0, y0, box, 6);
    expect(directFraction).toBeGreaterThan(0.05);
    expect(accFraction).toBeLessThan(directFraction * 0.85);
    expect(directFraction - accFraction).toBeGreaterThan(0.1);
  } finally {
    await context.close();
  }
});

// Proves per-sample jitter reaches the rasterized silhouette itself (not
// just shading): two individual raw samples of a constant-color,
// backdrop-less sphere at jitter (0,0) and (0.5,0.5), read back through
// the real present() path, must disagree on coverage (alpha) at more
// than a handful of edge pixels. Alpha-only on purpose: it isolates
// coverage from any color-readback nuance.
test('a single raw accumulator sample at jitter (0.5,0.5) has different silhouette coverage than jitter (0,0)', async ({ browser, embedURL }) => {
  const { context, page } = await loadSphereView(browser, embedURL, OPAQUE_MTLX, { geom: 'sphere' });
  try {
    await page.evaluate(() => {
      const h = window.__mtlxViewerHandle;
      if (h.setBackdrop) h.setBackdrop('none');
      if (h.setAutoRotate) h.setAutoRotate(false);
    });
    await page.waitForTimeout(300);

    const result = await page.evaluate(() => {
      const h = window.__mtlxViewerHandle;
      const { renderer, camera } = h.__debug();
      const canvas = renderer.domElement;
      const w = canvas.width, ht = canvas.height;
      const readCanvas = () => {
        const c = document.createElement('canvas'); c.width = w; c.height = ht;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(canvas, 0, 0);
        return ctx.getImageData(0, 0, w, ht).data;
      };
      // Renders exactly ONE accumulator sample at an explicit jitter and
      // reads it back through present(), i.e. through the exact path a
      // real accumulation cycle uses for every fold.
      const renderOneSamplePresented = (jx, jy) => {
        const acc = window.createFrameAccumulator(renderer);
        acc.beginSample();
        try {
          if (camera.setViewOffset) camera.setViewOffset(w, ht, jx, jy, w, ht);
          h.renderNow();
        } finally {
          if (camera.clearViewOffset) camera.clearViewOffset();
        }
        acc.endSample();
        acc.present();
        const px = readCanvas();
        acc.dispose();
        h.invalidateAccumulation();
        return px;
      };
      const a = renderOneSamplePresented(0, 0);
      const b = renderOneSamplePresented(0.5, 0.5);
      let changedCoverage = 0;
      for (let i = 0; i < a.length; i += 4) {
        // Coverage flip: alpha crosses from background(0) to foreground(255) or vice versa.
        if ((a[i + 3] < 40) !== (b[i + 3] < 40)) changedCoverage++;
      }
      return { changedCoverage, w, ht };
    });
    expect(result.changedCoverage).toBeGreaterThan(50);
  } finally {
    await context.close();
  }
});

// Transparent-embed correctness: canvas pixels outside the sphere are
// (0,0,0,0), so straight-alpha mixing of a foreground sample (c, 1) and
// a background sample (0,0,0,0) yields (c*k, k) at a partial-coverage
// pixel, exactly the premultiplied value an MSAA resolve would also
// write; the browser's unpremultiplied PNG readback then divides RGB
// back by k, correctly recovering ~c. present() must write that value
// RAW (no extra premultiply pass): re-premultiplying darkens every
// partial-alpha pixel on a transparent background, which this catches.
test('accumulated snapshot keeps silhouette RGB close to the sphere color after unpremultiplied readback', async ({ browser, embedURL }) => {
  const { context, page } = await loadSphereView(browser, embedURL, FLAT_MTLX, { geom: 'sphere' });
  try {
    await page.evaluate(() => {
      const h = window.__mtlxViewerHandle;
      if (h.setBackdrop) h.setBackdrop('none');
      if (h.setAutoRotate) h.setAutoRotate(false);
    });
    await page.waitForTimeout(300);
    await expect.poll(() => page.evaluate(() => window.__mtlxViewerHandle.getAccumulationState()),
      { timeout: WAIT_TIMEOUT }).toMatchObject({ samples: 32, converged: true });

    const accUrl = await page.evaluate(() => window.__mtlxViewerHandle.snapshot({ accumulated: true }));
    const accumulated = decodePNG(Buffer.from(accUrl.split(',')[1], 'base64'));

    // Reference color per partial-alpha pixel: its own row's NEAREST
    // fully-opaque neighbor (scanning outward a few pixels either way),
    // not the frame center, so the sphere's own local shading gradient
    // (still present even at specular=0, from the irradiance falloff
    // toward the silhouette) never gets counted as readback error.
    const nearestOpaqueColor = (x, y) => {
      for (let d = 1; d <= 6; d++) {
        for (const nx of [x - d, x + d]) {
          if (nx < 0 || nx >= accumulated.width) continue;
          const q = accumulated.getPixel(nx, y);
          if (q.a >= 250) return q;
        }
      }
      return null;
    };
    let partialCount = 0, maxDist = 0, sumDist = 0;
    for (let y = 0; y < accumulated.height; y++) {
      for (let x = 0; x < accumulated.width; x++) {
        const p = accumulated.getPixel(x, y);
        if (p.a <= 40 || p.a >= 215) continue;
        const ref = nearestOpaqueColor(x, y);
        if (!ref) continue;
        const dist = Math.max(Math.abs(p.r - ref.r), Math.abs(p.g - ref.g), Math.abs(p.b - ref.b));
        partialCount++;
        sumDist += dist;
        maxDist = Math.max(maxDist, dist);
      }
    }
    expect(partialCount).toBeGreaterThan(20);
    expect(sumDist / partialCount).toBeLessThan(12);
  } finally {
    await context.close();
  }
});

// Regression: snapshot({accumulated:true}) presented the accumulator's
// already-converged average verbatim, ignoring accumForce/the digest.
// A uniform poke right before the call (mirrors the Graph Editor's
// tryFastUniformUpdate) never reaches invalidateAccumulation()'s
// consumer (animate() ticks), so the stale 32-sample average of the OLD
// color got returned instead of the new one.
test('snapshot({accumulated:true}) reflects a uniform poke immediately, not the stale converged image', async ({ browser, embedURL }) => {
  const { context, page } = await loadSphereView(browser, embedURL, OPAQUE_MTLX, { geom: 'sphere' });
  try {
    await page.evaluate(() => {
      const h = window.__mtlxViewerHandle;
      if (h.setBackdrop) h.setBackdrop('none');
      if (h.setAutoRotate) h.setAutoRotate(false);
    });
    await page.waitForTimeout(300);
    await expect.poll(() => page.evaluate(() => window.__mtlxViewerHandle.getAccumulationState()),
      { timeout: WAIT_TIMEOUT }).toMatchObject({ samples: 32, converged: true });

    const oldUrl = await page.evaluate(() => window.__mtlxViewerHandle.snapshot({ accumulated: true }));
    const old = decodePNG(Buffer.from(oldUrl.split(',')[1], 'base64'));
    const cx = Math.floor(old.width / 2), cy = Math.floor(old.height / 2);
    const oldCenter = old.getPixel(cx, cy);

    // Poke a uniform directly, same pattern as the "camera orbit and a
    // uniform poke" test above: changes the sphere's own rendered color
    // without going through applyMaterial/a view rebuild.
    await page.evaluate(() => {
      const h = window.__mtlxViewerHandle;
      const u = h.uniforms;
      const key = Object.keys(u).find((k) => k.indexOf('base_color') !== -1);
      if (key && u[key].value && typeof u[key].value.x === 'number') u[key].value.set(0.05, 0.9, 0.05);
    });

    const [accUrl, freshDirectUrl] = await page.evaluate(() => {
      const h = window.__mtlxViewerHandle;
      const a = h.snapshot({ accumulated: true });
      const d = h.snapshot();
      return [a, d];
    });
    const accumulated = decodePNG(Buffer.from(accUrl.split(',')[1], 'base64'));
    const freshDirect = decodePNG(Buffer.from(freshDirectUrl.split(',')[1], 'base64'));
    const accCenter = accumulated.getPixel(cx, cy);
    const freshCenter = freshDirect.getPixel(cx, cy);

    // Not the stale (old, red) image any more.
    expect(Math.abs(accCenter.r - oldCenter.r) + Math.abs(accCenter.g - oldCenter.g)).toBeGreaterThan(40);
    // Matches a fresh direct snapshot of the NEW (green) state.
    expect(Math.abs(accCenter.r - freshCenter.r) + Math.abs(accCenter.g - freshCenter.g) + Math.abs(accCenter.b - freshCenter.b))
      .toBeLessThanOrEqual(4);
  } finally {
    await context.close();
  }
});
