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
