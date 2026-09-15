// tests/embed/usd-scene-accumulation.spec.mjs: progressive jittered-frame
// accumulation in the USD Scene renderer (js/usd-scene-renderer.js), the
// same feature already covered for the preview tools by
// tests/embed/accumulation.spec.mjs. Builds a small stage directly via
// window.createMtlxSceneView (no directory upload), same pattern as
// tests/embed/usd-scene-material-mix.spec.mjs.

import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

// Plain opaque standard_surface, no textures: matches
// tests/embed/accumulation.spec.mjs's OPAQUE_MTLX.
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

// A flat-shaded box (24 verts, one quad per face) and a ground plane
// underneath it: a simple lit shape with real silhouette edges, no
// external assets.
function buildBox(sx, sy, sz, cx, cy, cz) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const faces = [
    [[0, 0, 1], [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]]],
    [[0, 0, -1], [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]]],
    [[1, 0, 0], [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]]],
    [[-1, 0, 0], [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]]],
    [[0, 1, 0], [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]]],
    [[0, -1, 0], [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]]],
  ];
  const positions = [], normals = [], uvs = [], indices = [];
  let vi = 0;
  const faceUvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (const [n, corners] of faces) {
    for (let i = 0; i < 4; i++) {
      const c = corners[i];
      positions.push(c[0] + cx, c[1] + cy, c[2] + cz);
      normals.push(n[0], n[1], n[2]);
      uvs.push(faceUvs[i][0], faceUvs[i][1]);
    }
    indices.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
    vi += 4;
  }
  return { positions, normals, uvs, indices };
}

function buildPlane(sx, sz, y) {
  const hx = sx / 2, hz = sz / 2;
  return {
    positions: [-hx, y, -hz, hx, y, -hz, hx, y, hz, -hx, y, hz],
    normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
    indices: [0, 1, 2, 0, 2, 3],
  };
}

// Static (no u_time) high-frequency fractal3d noise driving base_color,
// object-space position scaled way up so it aliases hard at box/screen
// resolution: same pattern used by tests/embed/accumulation.spec.mjs's
// own regression test for the P-class bug (matrix uniforms baked before
// camera.setViewOffset instead of read live at draw time).
const NOISE_MTLX = `<?xml version="1.0"?>
<materialx version="1.39" colorspace="lin_rec709">
  <nodegraph name="NG_scene_accum_noise">
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
  <standard_surface name="SR_scene_accum_noise" type="surfaceshader">
    <input name="base" type="float" value="1.0" />
    <input name="base_color" type="color3" nodegraph="NG_scene_accum_noise" output="out" />
    <input name="specular" type="float" value="0.0" />
  </standard_surface>
  <surfacematerial name="NoiseMat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="SR_scene_accum_noise" />
  </surfacematerial>
</materialx>`;

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const box = buildBox(1, 1, 1, 0, 0.5, 0);
const plane = buildPlane(6, 6, 0);

function buildStage() {
  return {
    meshes: [
      {
        primPath: '/Scene/Box',
        positions: box.positions, normals: box.normals, uvs: box.uvs, indices: box.indices,
        matrix: IDENTITY,
        groups: [{ start: 0, count: box.indices.length, materialPath: '/Scene/Mat' }],
      },
      {
        primPath: '/Scene/Plane',
        positions: plane.positions, normals: plane.normals, uvs: plane.uvs, indices: plane.indices,
        matrix: IDENTITY,
        groups: [{ start: 0, count: plane.indices.length, materialPath: '/Scene/Mat' }],
      },
    ],
    materials: [{ path: '/Scene/Mat', sourceAsset: 'accum.mtlx', subIdentifier: 'AccumMat' }],
    cameras: [{
      primPath: '/Scene/Cam',
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2.5, 2, 2.5, 1],
      focalLength: 35, verticalAperture: 24, clippingRange: [0.1, 1000],
    }],
    lights: [],
    warnings: [],
  };
}

// Creates the scene view in a hidden offscreen container and stashes the
// handle on window for later page.evaluate/waitForFunction polling
// (createMtlxSceneView is called directly, not through the app's own
// React state, so there is no window.__mtlxUsdSceneHandle here).
async function setup(browser, embedURL, xml = OPAQUE_MTLX, stage = buildStage()) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => typeof window.createMtlxSceneView === 'function');
  await page.evaluate(async ({ xml, stage }) => {
    const holder = document.createElement('div');
    holder.style.cssText = 'width:320px;height:240px;position:absolute;left:-2000px;top:0;';
    document.body.appendChild(holder);
    const h = await window.createMtlxSceneView({
      container: holder, stage,
      files: [{ path: 'accum.mtlx', data: new Blob([xml], { type: 'application/xml' }) }],
      version: '1.39.5',
    });
    h.setBackdrop('none');
    window.__accumTestHandle = h;
    window.__accumTestHolder = holder;
  }, { xml, stage });
  return { context, page };
}

// A single large box filling most of the frame, so the interior-variance
// regression test below reads mostly noise-shaded pixels, not silhouette.
function buildNoiseStage() {
  const bigBox = buildBox(3, 3, 3, 0, 0, 0);
  return {
    meshes: [{
      primPath: '/Scene/Box',
      positions: bigBox.positions, normals: bigBox.normals, uvs: bigBox.uvs, indices: bigBox.indices,
      matrix: IDENTITY,
      groups: [{ start: 0, count: bigBox.indices.length, materialPath: '/Scene/Mat' }],
    }],
    materials: [{ path: '/Scene/Mat', sourceAsset: 'accum.mtlx', subIdentifier: 'NoiseMat' }],
    cameras: [{
      primPath: '/Scene/Cam',
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1.8, 1.2, 1.8, 1],
      focalLength: 35, verticalAperture: 24, clippingRange: [0.1, 1000],
    }],
    lights: [],
    warnings: [],
  };
}

// Fraction of interior pixels whose value differs from their own 3x3
// neighborhood mean by more than `threshold` levels (any channel): same
// speckle metric tests/embed/accumulation.spec.mjs uses for its own
// jitter-reaches-the-shader regression test.
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

async function teardown(page, context) {
  await page.evaluate(() => {
    if (window.__accumTestHandle) window.__accumTestHandle.dispose();
    if (window.__accumTestHolder) window.__accumTestHolder.remove();
  }).catch(() => {});
  await context.close();
}

test('@scene still camera converges to 32 samples and stops drawing', async ({ browser, embedURL }) => {
  const { context, page } = await setup(browser, embedURL);
  try {
    await expect.poll(() => page.evaluate(() => window.__accumTestHandle.getAccumulationState()),
      { timeout: WAIT_TIMEOUT }).toMatchObject({ samples: 32, converged: true, reason: null });

    const frameBefore = await page.evaluate(() => window.__accumTestHandle.renderer.info.render.frame);
    await page.waitForTimeout(500);
    const frameAfter = await page.evaluate(() => window.__accumTestHandle.renderer.info.render.frame);
    expect(frameAfter).toBe(frameBefore);
  } finally {
    await teardown(page, context);
  }
});

test('@scene applyCamera resets accumulation samples within about one frame', async ({ browser, embedURL }) => {
  const { context, page } = await setup(browser, embedURL);
  try {
    await expect.poll(() => page.evaluate(() => window.__accumTestHandle.getAccumulationState()),
      { timeout: WAIT_TIMEOUT }).toMatchObject({ samples: 32, converged: true });

    await page.evaluate(() => window.__accumTestHandle.applyCamera('/Scene/Cam'));
    await page.waitForTimeout(80);
    const after = await page.evaluate(() => window.__accumTestHandle.getAccumulationState());
    expect(after.samples).toBeLessThan(32);
  } finally {
    await teardown(page, context);
  }
});

test('@scene presentation pipeline on and off both converge; accumulated snapshot differs mainly near edges', async ({ browser, embedURL }) => {
  const { context, page } = await setup(browser, embedURL);
  try {
    // HDR presentation on.
    await page.evaluate(() => window.__accumTestHandle.setPresentation({ enabled: true }));
    await expect.poll(() => page.evaluate(() => window.__accumTestHandle.getAccumulationState()),
      { timeout: WAIT_TIMEOUT }).toMatchObject({ samples: 32, converged: true });
    const [directOnUrl, accOnUrl] = await page.evaluate(() => {
      const h = window.__accumTestHandle;
      return [h.snapshot(), h.snapshot({ accumulated: true })];
    });
    const directOn = decodePNG(Buffer.from(directOnUrl.split(',')[1], 'base64'));
    const accOn = decodePNG(Buffer.from(accOnUrl.split(',')[1], 'base64'));
    expect(isBlank(accOn)).toBe(false);

    // HDR presentation off.
    await page.evaluate(() => window.__accumTestHandle.setPresentation({ enabled: false }));
    await expect.poll(() => page.evaluate(() => window.__accumTestHandle.getAccumulationState()),
      { timeout: WAIT_TIMEOUT }).toMatchObject({ samples: 32, converged: true });
    const [directOffUrl, accOffUrl] = await page.evaluate(() => {
      const h = window.__accumTestHandle;
      return [h.snapshot(), h.snapshot({ accumulated: true })];
    });
    const directOff = decodePNG(Buffer.from(directOffUrl.split(',')[1], 'base64'));
    const accOff = decodePNG(Buffer.from(accOffUrl.split(',')[1], 'base64'));
    expect(isBlank(accOff)).toBe(false);

    // Accumulated vs. direct: interior pixels close, some pixel changed
    // meaningfully (the silhouette edges), for both presentation modes.
    for (const [direct, acc] of [[directOn, accOn], [directOff, accOff]]) {
      expect(acc.width).toBe(direct.width);
      expect(acc.height).toBe(direct.height);
      const box = Math.floor(Math.min(direct.width, direct.height) * 0.08);
      const x0 = Math.floor((direct.width - box) / 2), y0 = Math.floor((direct.height - box) / 2);
      let sum = 0, n = 0;
      for (let y = y0; y < y0 + box; y++) {
        for (let x = x0; x < x0 + box; x++) {
          const a = direct.getPixel(x, y), b = acc.getPixel(x, y);
          sum += Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
          n += 3;
        }
      }
      expect(sum / n).toBeLessThanOrEqual(6);
    }
  } finally {
    await teardown(page, context);
  }
});

function isBlank(png) {
  let sum = 0;
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const p = png.getPixel(x, y);
    sum += p.r + p.g + p.b;
  }
  return sum === 0;
}

test('@scene turning accumulation off gives reason disabled and a stable direct canvas', async ({ browser, embedURL }) => {
  const { context, page } = await setup(browser, embedURL);
  try {
    await page.evaluate(() => window.setAccumulationEnabled(false));
    await page.waitForTimeout(150);
    const state = await page.evaluate(() => window.__accumTestHandle.getAccumulationState());
    expect(state.enabled).toBe(false);
    expect(state.reason).toBe('disabled');
    expect(state.samples).toBe(0);

    const [url1, url2] = await page.evaluate(() => {
      const h = window.__accumTestHandle;
      return [h.snapshot(), h.snapshot()];
    });
    const png1 = decodePNG(Buffer.from(url1.split(',')[1], 'base64'));
    const png2 = decodePNG(Buffer.from(url2.split(',')[1], 'base64'));
    let maxDiff = 0;
    for (let y = 0; y < png1.height; y++) for (let x = 0; x < png1.width; x++) {
      const a = png1.getPixel(x, y), b = png2.getPixel(x, y);
      maxDiff = Math.max(maxDiff, Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
    }
    expect(maxDiff).toBeLessThanOrEqual(1);
  } finally {
    await page.evaluate(() => window.setAccumulationEnabled(true)).catch(() => {});
    await teardown(page, context);
  }
});

test('@scene toggling Texel-space bump in the render settings popover flips getHeightToNormalTexel', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();

  const before = await page.evaluate(() => !!(window.getHeightToNormalTexel && window.getHeightToNormalTexel()));

  const button = page.getByTestId('usd-scene-render-settings');
  await button.click();
  const popover = page.getByTestId('usd-scene-render-settings-popover');
  await expect(popover).toBeVisible();
  await popover.getByRole('button', { name: 'Geometry and Textures', exact: true }).click();
  await expect(popover.getByText('Texel-space bump', { exact: true })).toBeVisible();

  const toggle = popover.locator('label').filter({ hasText: 'Texel-space bump' }).getByRole('switch');
  expect(await toggle.isChecked()).toBe(before);
  await toggle.click();
  await page.waitForTimeout(50);
  const after = await page.evaluate(() => !!(window.getHeightToNormalTexel && window.getHeightToNormalTexel()));
  expect(after).toBe(!before);
  expect(await toggle.isChecked()).toBe(!before);

  // Restore.
  await toggle.click();
  await page.waitForTimeout(50);
  const restored = await page.evaluate(() => !!(window.getHeightToNormalTexel && window.getHeightToNormalTexel()));
  expect(restored).toBe(before);
});

// Regression for the same bug class found in the preview engine: matrix
// uniforms baked once per frame BEFORE camera.setViewOffset() would make
// every "jittered" sample identical for a MaterialX RawShaderMaterial,
// while built-in three.js materials (which read camera.projectionMatrix
// live at draw time) jitter fine and mask the bug. The Scene pushes
// camera matrices per-object via onBeforeRender (applyObjectUniforms),
// which fires during renderer.render() after setViewOffset already ran,
// so this proves the fix empirically rather than by code inspection alone.
test('@scene accumulation smooths a high-frequency procedural MaterialX material', async ({ browser, embedURL }) => {
  const { context, page } = await setup(browser, embedURL, NOISE_MTLX, buildNoiseStage());
  try {
    await page.waitForTimeout(200);
    await expect.poll(() => page.evaluate(() => window.__accumTestHandle.getAccumulationState()),
      { timeout: WAIT_TIMEOUT }).toMatchObject({ samples: 32, converged: true });

    const [directUrl, accUrl] = await page.evaluate(() => {
      const h = window.__accumTestHandle;
      return [h.snapshot(), h.snapshot({ accumulated: true })];
    });
    const direct = decodePNG(Buffer.from(directUrl.split(',')[1], 'base64'));
    const accumulated = decodePNG(Buffer.from(accUrl.split(',')[1], 'base64'));

    const box = Math.floor(Math.min(direct.width, direct.height) * 0.5);
    const x0 = Math.floor((direct.width - box) / 2), y0 = Math.floor((direct.height - box) / 2);
    const directFraction = speckleFraction(direct, x0, y0, box, 6);
    const accFraction = speckleFraction(accumulated, x0, y0, box, 6);
    expect(directFraction).toBeGreaterThan(0.05);
    expect(accFraction).toBeLessThan(directFraction * 0.85);
    expect(directFraction - accFraction).toBeGreaterThan(0.1);
  } finally {
    await teardown(page, context);
  }
});

// Regression: snapshot({accumulated:true}) presented the accumulator's
// already-converged average verbatim, ignoring accumForce/the digest.
// A state change right before the call (here: a camera move) never
// reaches invalidateAccumulation()'s consumer (the animate() loop, which
// this call bypasses), so the stale 32-sample average of the OLD camera
// pose got returned instead of a fresh one for the new pose.
test('@scene snapshot({accumulated:true}) reflects a camera move immediately, not the stale converged image', async ({ browser, embedURL }) => {
  const { context, page } = await setup(browser, embedURL);
  try {
    await expect.poll(() => page.evaluate(() => window.__accumTestHandle.getAccumulationState()),
      { timeout: WAIT_TIMEOUT }).toMatchObject({ samples: 32, converged: true });

    const oldUrl = await page.evaluate(() => window.__accumTestHandle.snapshot({ accumulated: true }));
    const old = decodePNG(Buffer.from(oldUrl.split(',')[1], 'base64'));
    const cx = Math.floor(old.width / 2), cy = Math.floor(old.height / 2);
    const oldCenter = old.getPixel(cx, cy);

    await page.evaluate(() => window.__accumTestHandle.setCamera({ position: [-3, 0.6, -3], target: [0, 0.5, 0] }));

    const [accUrl, freshDirectUrl] = await page.evaluate(() => {
      const h = window.__accumTestHandle;
      const a = h.snapshot({ accumulated: true });
      const d = h.snapshot();
      return [a, d];
    });
    const accumulated = decodePNG(Buffer.from(accUrl.split(',')[1], 'base64'));
    const freshDirect = decodePNG(Buffer.from(freshDirectUrl.split(',')[1], 'base64'));
    const accCenter = accumulated.getPixel(cx, cy);
    const freshCenter = freshDirect.getPixel(cx, cy);

    // Not the stale (old camera pose) image any more.
    expect(Math.abs(accCenter.r - oldCenter.r) + Math.abs(accCenter.g - oldCenter.g) + Math.abs(accCenter.b - oldCenter.b))
      .toBeGreaterThan(20);
    // Matches a fresh direct snapshot of the NEW camera pose.
    expect(Math.abs(accCenter.r - freshCenter.r) + Math.abs(accCenter.g - freshCenter.g) + Math.abs(accCenter.b - freshCenter.b))
      .toBeLessThanOrEqual(6);
  } finally {
    await teardown(page, context);
  }
});
