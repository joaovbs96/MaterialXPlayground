import { test, expect } from './lib/test-base.mjs';

// Ortho camera: left=-128,right=128,bottom=-128,top=128 over a 256px target
// maps one world unit to exactly one pixel, and pixel = world + 128 on both
// axes, so quad half-extents and pixel offsets can be used interchangeably.
const SIZE = 256;
const HALF = SIZE / 2;

test.describe('@scene bloom reconstruction', () => {
  test.beforeEach(async ({ page, embedURL }) => {
    await page.goto(embedURL + '/index.html#!scene');
    await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
    await page.evaluate(({ size, half }) => {
      const T = window.THREE;
      const emitterXml = (radiance) => `<materialx version="1.39"><standard_surface name="surface" type="surfaceshader">
        <input name="base" type="float" value="0"/><input name="specular" type="float" value="0"/>
        <input name="transmission" type="float" value="0"/>
        <input name="emission" type="float" value="${radiance}"/><input name="emission_color" type="color3" value="1,1,1"/>
      </standard_surface><surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial></materialx>`;
      const opaqueXml = `<materialx version="1.39"><standard_surface name="surface" type="surfaceshader">
        <input name="base" type="float" value="1"/><input name="base_color" type="color3" value="0.4,0.4,0.4"/>
        <input name="specular" type="float" value="0"/><input name="transmission" type="float" value="0"/>
        <input name="emission" type="float" value="0"/>
      </standard_surface><surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial></materialx>`;
      // quads: [{ radiance?, half, cx?, cy? }]. Omitting radiance gives an
      // opaque, non-emissive reference patch.
      async function buildScene(quads) {
        const env = await window.getMxEnv();
        const docs = [], materials = [], meshes = [];
        for (let i = 0; i < quads.length; i++) {
          const q = quads[i];
          const xml = q.radiance != null ? emitterXml(q.radiance) : opaqueXml;
          const doc = env.mx.createDocument();
          await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
          if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
          const node = window.listDocRenderables(doc)[0].node;
          docs.push(doc);
          const mpath = '/M' + i;
          materials.push({ path: mpath, node });
          const qh = q.half, cx = q.cx || 0, cy = q.cy || 0;
          meshes.push({
            primPath: '/Q' + i, materialPath: mpath,
            positions: new Float32Array([cx - qh, cy - qh, 0, cx + qh, cy - qh, 0, cx + qh, cy + qh, 0, cx - qh, cy + qh, 0]),
            normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
            uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
            indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
          });
        }
        const holder = document.createElement('div');
        holder.style.cssText = 'position:fixed;left:0;top:0;width:' + size + 'px;height:' + size + 'px';
        document.body.appendChild(holder);
        const handle = await window.createMtlxSceneView({ container: holder, version: '1.39.5',
          stage: { upAxis: 'Y', metersPerUnit: 1, materials, lights: [], meshes } });
        handle.setBackdrop('none'); handle.setEnvironment(window.makeFlatEnvironment([0, 0, 0])); handle.setEnvExposure(0);
        handle.setSkyVisibility(false); handle.setShadowsEnabled(false); handle.setAmbientOcclusionEnabled(false);
        handle.setSceneDisplayTransform('lin_rec709');
        // Override the render camera's matrices in place with an orthographic
        // projection, matching the technique other scene specs use to drive
        // the shared perspective camera object through a known 1:1 mapping.
        const debug = handle.__debug();
        const ortho = new T.OrthographicCamera(-half, half, half, -half, 0.1, 100);
        ortho.position.set(0, 0, 10); ortho.up.set(0, 1, 0); ortho.lookAt(0, 0, 0);
        ortho.updateMatrixWorld(true); ortho.updateProjectionMatrix();
        debug.camera.position.copy(ortho.position); debug.camera.quaternion.copy(ortho.quaternion);
        debug.camera.updateMatrixWorld(true);
        debug.camera.projectionMatrix.copy(ortho.projectionMatrix);
        debug.camera.projectionMatrixInverse.copy(ortho.projectionMatrixInverse);
        return { handle, holder, docs };
      }
      function disposeScene(scene) {
        scene.handle.dispose(); scene.holder.remove(); scene.docs.forEach((d) => d.delete());
      }
      function renderView(handle, presentation) {
        const renderer = handle.renderer, gl = renderer.getContext();
        handle.setPresentation(Object.assign({ enabled: true, antialias: false, samples: 0, persist: false }, presentation));
        const target = new T.WebGLRenderTarget(size, size, { type: T.FloatType, format: T.RGBAFormat, minFilter: T.NearestFilter, magFilter: T.NearestFilter });
        while (gl.getError() !== gl.NO_ERROR) { /* clear stale diagnostics before the measured render */ }
        renderer.setRenderTarget(target);
        handle.renderNow();
        const pixels = new Float32Array(size * size * 4);
        renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
        const error = gl.getError();
        renderer.setRenderTarget(null); target.dispose();
        if (error !== gl.NO_ERROR) throw new Error('GL error ' + error);
        return pixels;
      }
      const at = (x, y) => (y * size + x) * 4;
      const luma = (pixels, i) => 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      const sumEnergy = (pixels) => { let s = 0; for (let i = 0; i < pixels.length; i += 4) s += pixels[i] + pixels[i + 1] + pixels[i + 2]; return s; };
      // Radial profile along +X from the image centre: first x whose luma
      // drops under `fraction` of the centre peak, as a pixel distance.
      function haloRadius(pixels, fraction = 0.05) {
        const cx = size / 2, cy = size / 2, peak = luma(pixels, at(cx, cy));
        for (let x = cx; x < size; x++) if (luma(pixels, at(x, cy)) < peak * fraction) return { radius: x - cx, peak };
        return { radius: size / 2, peak };
      }
      window.__bloom = { buildScene, disposeScene, renderView, at, luma, sumEnergy, haloRadius };
    }, { size: SIZE, half: HALF });
  });

  test('@scene bloom uniform field is flat away from a 32px border', async ({ page }) => {
    const result = await page.evaluate(async ({ half, border, size }) => {
      // The emitter overshoots the visible frustum by 32 world units on
      // every side, so the whole 256x256 image sees a uniform radiance
      // field before any bloom processing.
      const scene = await window.__bloom.buildScene([{ radiance: 4, half: half + 32 }]);
      const pixels = window.__bloom.renderView(scene.handle, { bloom: true, strength: 1, threshold: 1, knee: 0.5, radius: 0.65, debugView: 'bloom' });
      window.__bloom.disposeScene(scene);
      let min = Infinity, max = -Infinity;
      for (let y = border; y < size - border; y++) for (let x = border; x < size - border; x++) {
        const l = window.__bloom.luma(pixels, window.__bloom.at(x, y));
        min = Math.min(min, l); max = Math.max(max, l);
      }
      return { min, max };
    }, { half: HALF, border: 32, size: SIZE });
    console.log('[bloom-uniform]', JSON.stringify(result));
    expect(result.min).toBeGreaterThan(0);
    expect((result.max - result.min) / result.max).toBeLessThan(0.01);
  });

  test('@scene bloom conserves the highlight energy of a small impulse emitter', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const scene = await window.__bloom.buildScene([{ radiance: 8, half: 2 }]); // 4x4 px
      const highlights = window.__bloom.renderView(scene.handle, { bloom: true, strength: 1, threshold: 1, knee: 0.5, radius: 0.65, debugView: 'highlights' });
      const bloom = window.__bloom.renderView(scene.handle, { bloom: true, strength: 1, threshold: 1, knee: 0.5, radius: 0.65, debugView: 'bloom' });
      window.__bloom.disposeScene(scene);
      return { highlights: window.__bloom.sumEnergy(highlights), bloom: window.__bloom.sumEnergy(bloom) };
    });
    console.log('[bloom-impulse]', JSON.stringify(result));
    expect(result.highlights).toBeGreaterThan(0);
    expect(Math.abs(result.bloom - result.highlights) / result.highlights).toBeLessThan(0.02);
  });

  test('@scene bloom knee is zero at its boundary and continuous just above it', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const threshold = 1, knee = 0.5, kWidth = 2 * threshold * knee;
      const rZero = threshold * (1 - knee), rA = rZero + 0.02 * kWidth, rB = rA * 1.02;
      async function centerBloom(radiance) {
        const scene = await window.__bloom.buildScene([{ radiance, half: 8 }]);
        const bloom = window.__bloom.renderView(scene.handle, { bloom: true, strength: 1, threshold, knee, radius: 0.65, debugView: 'bloom' });
        const value = window.__bloom.luma(bloom, window.__bloom.at(128, 128));
        window.__bloom.disposeScene(scene);
        return value;
      }
      return { rA, rB, zero: await centerBloom(rZero), a: await centerBloom(rA), b: await centerBloom(rB) };
    });
    console.log('[bloom-knee]', JSON.stringify(result));
    expect(result.zero).toBeLessThan(1e-4);
    expect(result.b).toBeGreaterThan(result.a);
    expect(Math.abs(result.b - result.a)).toBeLessThan(0.01 * result.rB);
  });

  test('@scene bloom halo energy is monotonic in emitter radiance', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const rows = [];
      for (const radiance of [2, 8, 32]) {
        const scene = await window.__bloom.buildScene([{ radiance, half: 4 }]);
        const bloom = window.__bloom.renderView(scene.handle, { bloom: true, strength: 1, threshold: 1, knee: 0.5, radius: 0.65, debugView: 'bloom' });
        window.__bloom.disposeScene(scene);
        rows.push({ radiance, energy: window.__bloom.sumEnergy(bloom) });
      }
      return rows;
    });
    console.log('[bloom-intensity-sweep]', JSON.stringify(result));
    expect(result[1].energy).toBeGreaterThan(result[0].energy);
    expect(result[2].energy).toBeGreaterThan(result[1].energy);
  });

  test('@scene bloom halo radius is monotonic in emitter size', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const rows = [];
      for (const size of [4, 16, 64]) {
        const scene = await window.__bloom.buildScene([{ radiance: 8, half: size / 2 }]);
        const bloom = window.__bloom.renderView(scene.handle, { bloom: true, strength: 1, threshold: 1, knee: 0.5, radius: 0.65, debugView: 'bloom' });
        window.__bloom.disposeScene(scene);
        rows.push({ size, ...window.__bloom.haloRadius(bloom) });
      }
      return rows;
    });
    console.log('[bloom-size-sweep]', JSON.stringify(result));
    expect(result[1].radius).toBeGreaterThan(result[0].radius);
    expect(result[2].radius).toBeGreaterThan(result[1].radius);
  });

  test('@scene bloom radius control shrinks the halo at low radius versus high', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const rows = [];
      for (const radius of [0.1, 0.9]) {
        const scene = await window.__bloom.buildScene([{ radiance: 8, half: 8 }]);
        const bloom = window.__bloom.renderView(scene.handle, { bloom: true, strength: 1, threshold: 1, knee: 0.5, radius, debugView: 'bloom' });
        window.__bloom.disposeScene(scene);
        rows.push({ radius, ...window.__bloom.haloRadius(bloom) });
      }
      return rows;
    });
    console.log('[bloom-radius-control]', JSON.stringify(result));
    expect(result[1].radius).toBeGreaterThan(result[0].radius);
  });

  test('@scene bloom off is a single presentation pass', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const scene = await window.__bloom.buildScene([{ radiance: 8, half: 8 }]);
      window.__bloom.renderView(scene.handle, { bloom: false, strength: 0.25, threshold: 1, knee: 0.5, radius: 0.65, debugView: 'final' });
      const passes = scene.handle.__debug().presentation.lastPasses;
      window.__bloom.disposeScene(scene);
      return { passes };
    });
    console.log('[bloom-off-passes]', JSON.stringify(result));
    expect(result.passes).toBe(1);
  });

  test('@scene transparent export keeps the halo visible over both black and white', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const scene = await window.__bloom.buildScene([
        { radiance: 12, half: 8 }, // emitter at the origin
        { half: 10, cx: -90, cy: 90 }, // opaque reference patch, far from the halo
      ]);
      const renderer = scene.handle.renderer;
      renderer.setClearColor(0, 0); // transparent background
      const on = window.__bloom.renderView(scene.handle, { bloom: true, strength: 1, threshold: 1, knee: 0.5, radius: 0.65, debugView: 'final' });
      const off = window.__bloom.renderView(scene.handle, { bloom: false, strength: 0, threshold: 1, knee: 0.5, radius: 0.65, debugView: 'final' });
      window.__bloom.disposeScene(scene);
      const over = (pixels, i, bg) => [0, 1, 2].map((c) => pixels[i + c] + bg[c] * (1 - pixels[i + 3]));
      const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      const haloIndex = window.__bloom.at(128 + 20, 128); // just outside the emitter's own 16px silhouette
      const refIndex = window.__bloom.at(128 - 90, 128 + 90); // inside the far opaque patch
      return {
        haloOnAlpha: on[haloIndex + 3], haloOffAlpha: off[haloIndex + 3],
        blackDiff: dist(over(on, haloIndex, [0, 0, 0]), over(off, haloIndex, [0, 0, 0])),
        whiteDiff: dist(over(on, haloIndex, [1, 1, 1]), over(off, haloIndex, [1, 1, 1])),
        refDiff: dist(over(on, refIndex, [0, 0, 0]), over(off, refIndex, [0, 0, 0])),
      };
    });
    console.log('[bloom-transparent-export]', JSON.stringify(result));
    expect(result.haloOnAlpha).toBeGreaterThan(result.haloOffAlpha);
    expect(result.blackDiff).toBeGreaterThan(0.01);
    expect(result.whiteDiff).toBeGreaterThan(0.01);
    expect(result.refDiff).toBeLessThan(0.005);
  });

  test('@scene bloom exposure and HDR range checks carried over from the old emission gate', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const scene = await window.__bloom.buildScene([{ radiance: 8, half: 8 }]);
      window.setDisplayExposure(0);
      const base = window.__bloom.renderView(scene.handle, { bloom: false, strength: 0, threshold: 1, knee: 0.5, radius: 0.65, debugView: 'linear' });
      const baseCenter = window.__bloom.luma(base, window.__bloom.at(128, 128));
      window.setDisplayExposure(1);
      const exposed = window.__bloom.renderView(scene.handle, { bloom: false, strength: 0, threshold: 1, knee: 0.5, radius: 0.65, debugView: 'no-bloom' });
      const exposedCenter = window.__bloom.luma(exposed, window.__bloom.at(128, 128));
      window.setDisplayExposure(0);
      window.__bloom.disposeScene(scene);
      return { baseCenter, exposedCenter, ratio: exposedCenter / baseCenter };
    });
    console.log('[bloom-exposure]', JSON.stringify(result));
    expect(result.baseCenter).toBeGreaterThan(1); // HDR values above 1 survive
    expect(result.ratio).toBeCloseTo(2, 1); // +1 EV doubles the pre-bloom linear response
  });
});
