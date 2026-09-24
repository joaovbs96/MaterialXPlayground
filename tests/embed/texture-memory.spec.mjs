// tests/embed/texture-memory.spec.mjs: P4c F3 acceptance. A preview
// handle's own textureSession (createTextureSession) must free its GL
// texture copies on dispose instead of leaking them into the shared
// TEXTURE_CACHE Map, and two uniforms sharing one file must decode it once.
// Runs against the real #!viewer engine globals, inline .mtlx + an
// in-page-generated PNG (no third-party texture files).

import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';

async function gotoEngine(page, embedURL) {
  await page.goto(embedURL + '/index.html#!viewer');
  await page.waitForFunction(
    () => window.getMxEnv && window.createMtlxRenderView && window.THREE && window.bindDroppedTextures,
    null, { timeout: WAIT_TIMEOUT }
  );
}

// One image node feeding base_color, filename "wood.png".
const TEXTURED_MTLX = `<?xml version="1.0"?>
<materialx version="1.39" colorspace="lin_rec709">
  <image name="img_basecolor" type="color3">
    <input name="file" type="filename" value="wood.png" />
  </image>
  <standard_surface name="SR_Textured" type="surfaceshader">
    <input name="base_color" type="color3" nodename="img_basecolor" />
  </standard_surface>
  <surfacematerial name="Textured" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="SR_Textured" />
  </surfacematerial>
</materialx>`;

// Two SEPARATE image nodes both referencing the SAME file "wood.png",
// feeding base_color and specular_color respectively, so bindDroppedTextures
// issues two concurrent filename-uniform binds for one underlying file.
const SHARED_TEXTURE_MTLX = `<?xml version="1.0"?>
<materialx version="1.39" colorspace="lin_rec709">
  <image name="img_a" type="color3">
    <input name="file" type="filename" value="wood.png" />
  </image>
  <image name="img_b" type="color3">
    <input name="file" type="filename" value="wood.png" />
  </image>
  <standard_surface name="SR_Shared" type="surfaceshader">
    <input name="base_color" type="color3" nodename="img_a" />
    <input name="specular_color" type="color3" nodename="img_b" />
  </standard_surface>
  <surfacematerial name="Shared" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="SR_Shared" />
  </surfacematerial>
</materialx>`;

test('renderer.info.memory.textures returns to its baseline after 5 material rebuilds of a textured material', async ({ page, embedURL }) => {
  await gotoEngine(page, embedURL);

  const counts = await page.evaluate(async ({ xml }) => {
    const env = await window.getMxEnv();

    // One in-page-generated PNG blob, no third-party file.
    const c = document.createElement('canvas');
    c.width = 4; c.height = 4;
    c.getContext('2d').fillRect(0, 0, 4, 4);
    const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
    const file = new File([blob], 'wood.png', { type: 'image/png' });

    const canvas = document.createElement('canvas');
    canvas.style.width = '128px';
    canvas.style.height = '128px';
    document.body.appendChild(canvas);

    const out = [];
    for (let i = 0; i < 5; i++) {
      const doc = env.mx.createDocument();
      await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
      if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
      const { name: materialName, node: renderable } = window.listDocRenderables(doc)[0];

      const view = await window.createMtlxRenderView({
        canvas, mx: env.mx, gen: env.gen, genContext: env.genContext, renderable,
        label: 'texture-memory-test', geomName: 'sphere', needsLighting: true,
        materialName, isMounted: () => true,
      });

      const rep = window.bindDroppedTextures(view, { 'wood.png': file });
      await Promise.all(rep.pending);
      view.renderNow();

      out.push(view.__debug().renderer.info.memory.textures);
      view.dispose();
    }
    return out;
  }, { xml: TEXTURED_MTLX });

  // Same texture, same sampler modes, rebuilt on the same canvas/GL context
  // 5 times. Cycle 1 also pays for lazily-created module-singleton GPU
  // resources (shared dummy/default textures), so it is the "baseline";
  // cycles 2-5 must return to exactly that baseline every time, never
  // climbing cycle over cycle the way the un-disposed TEXTURE_CACHE did.
  expect(counts.length).toBe(5);
  const baseline = counts[1];
  for (const n of counts.slice(1)) expect(n).toBe(baseline);
});

test('two uniforms sharing one file decode it once', async ({ page, embedURL }) => {
  await gotoEngine(page, embedURL);

  const result = await page.evaluate(async ({ xml }) => {
    const env = await window.getMxEnv();

    let decodeCalls = 0;
    const originalLoad = window.THREE.TextureLoader.prototype.load;
    window.THREE.TextureLoader.prototype.load = function (url, onLoad, onProgress, onError) {
      decodeCalls += 1;
      return originalLoad.call(this, url, onLoad, onProgress, onError);
    };

    try {
      const c = document.createElement('canvas');
      c.width = 4; c.height = 4;
      c.getContext('2d').fillRect(0, 0, 4, 4);
      const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
      const file = new File([blob], 'wood.png', { type: 'image/png' });

      const canvas = document.createElement('canvas');
      canvas.style.width = '128px';
      canvas.style.height = '128px';
      document.body.appendChild(canvas);

      const doc = env.mx.createDocument();
      await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
      if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
      const { name: materialName, node: renderable } = window.listDocRenderables(doc)[0];

      const view = await window.createMtlxRenderView({
        canvas, mx: env.mx, gen: env.gen, genContext: env.genContext, renderable,
        label: 'texture-memory-shared-test', geomName: 'sphere', needsLighting: true,
        materialName, isMounted: () => true,
      });

      const rep = window.bindDroppedTextures(view, { 'wood.png': file });
      await Promise.all(rep.pending);

      const stats = view.getTextureStats ? view.getTextureStats() : null;
      view.dispose();
      return { decodeCalls, stats };
    } finally {
      window.THREE.TextureLoader.prototype.load = originalLoad;
    }
  }, { xml: SHARED_TEXTURE_MTLX });

  expect(result.decodeCalls).toBe(1);
  expect(result.stats).toBeTruthy();
  expect(result.stats.sourceCount).toBe(1);
  expect(result.stats.wrapperCount).toBe(1);
});
