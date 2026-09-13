// Shadow transmittance gate: a per-face record plane (js/usd-scene-renderer.js
// updateShadowMap -> shadowRenderFaceTransmittance) lets a static thin sheet
// or single-closed-shell solid tint/attenuate a shadow instead of casting a
// flat opaque (or dithered) VSM occlusion. The receiver side is
// mx_shadow_transmittance in js/mtlx-engine.js.
//
// Geometry trick used throughout: a straight-down DistantLight (world -Y)
// means a blocker directly above a receiver casts its shadow onto that same
// (x,z) column with no lateral offset. The camera for each capture sits at
// receiver + (D,D,D) and looks at the receiver: for any object at
// height-drop d above the receiver (d <= D), the camera ray is offset by
// exactly d in x/z at that height (a property of the (D,D,D) diagonal), so a
// blocker of half-size less than d never intersects the camera's own sightline
// even though it fully blocks the light. Objects with d > D sit above the
// camera's own height and are automatically out of the ray's range. D=4 and a
// blocker half-size of <=1.2 keep a comfortable margin at every drop used here
// (3 or more).
import zlib from 'node:zlib';
import { test, expect } from './lib/test-base.mjs';

const D = 4;

const quad = (primPath, materialPath, cx, cy, cz, hx, hz) => ({
  primPath, materialPath,
  positions: new Float32Array([
    cx - hx, cy, cz - hz,
    cx + hx, cy, cz - hz,
    cx + hx, cy, cz + hz,
    cx - hx, cy, cz + hz,
  ]),
  normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
  uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
});

// Watertight box (same construction as usd-scene-omni-shadow.spec.mjs's
// blocker()), parametrized by center and per-axis half-extent.
const box = (primPath, materialPath, cx, cy, cz, hx, hy, hz) => {
  const xs = [cx - hx, cx + hx], ys = [cy - hy, cy + hy], zs = [cz - hz, cz + hz];
  const p = [
    xs[0], ys[0], zs[0], xs[1], ys[0], zs[0], xs[1], ys[1], zs[0], xs[0], ys[1], zs[0],
    xs[0], ys[0], zs[1], xs[1], ys[0], zs[1], xs[1], ys[1], zs[1], xs[0], ys[1], zs[1],
  ];
  return {
    primPath, materialPath, positions: new Float32Array(p),
    normals: new Float32Array(24), uvs: new Float32Array(16),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 1, 5, 6, 1, 6, 2, 0, 3, 7, 0, 7, 4]),
  };
};

const openPbrThin = (tint, weight = 1, opacity = 1) => `<materialx version="1.39">
  <open_pbr_surface name="surface" type="surfaceshader">
    <input name="base_weight" type="float" value="0"/><input name="specular_weight" type="float" value="0"/>
    <input name="transmission_weight" type="float" value="${weight}"/>
    <input name="transmission_color" type="color3" value="${tint.join(',')}"/>
    <input name="transmission_depth" type="float" value="0.1"/>
    <input name="geometry_opacity" type="float" value="${opacity}"/>
    <input name="geometry_thin_walled" type="boolean" value="true"/>
  </open_pbr_surface>
  <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;

const openPbrSolid = (weight, tint, depth) => `<materialx version="1.39">
  <open_pbr_surface name="surface" type="surfaceshader">
    <input name="base_weight" type="float" value="0"/><input name="specular_weight" type="float" value="0"/>
    <input name="transmission_weight" type="float" value="${weight}"/>
    <input name="transmission_color" type="color3" value="${tint.join(',')}"/>
    <input name="transmission_depth" type="float" value="${depth}"/>
    <input name="geometry_opacity" type="float" value="1"/>
    <input name="geometry_thin_walled" type="boolean" value="false"/>
  </open_pbr_surface>
  <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;

const openPbrOpaqueWhite = () => `<materialx version="1.39">
  <open_pbr_surface name="surface" type="surfaceshader">
    <input name="base_weight" type="float" value="1"/><input name="base_color" type="color3" value="1,1,1"/>
    <input name="specular_weight" type="float" value="0"/><input name="base_metalness" type="float" value="0"/>
    <input name="transmission_weight" type="float" value="0"/><input name="geometry_opacity" type="float" value="1"/>
  </open_pbr_surface>
  <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;

// Fully opaque, non-transmitter: a standard hard VSM occluder, unaffected by
// this feature. Used as the "rejected formula" control (gate 4).
const openPbrOpaqueOccluder = () => `<materialx version="1.39">
  <open_pbr_surface name="surface" type="surfaceshader">
    <input name="base_weight" type="float" value="0.5"/><input name="base_color" type="color3" value="0.2,0.2,0.2"/>
    <input name="specular_weight" type="float" value="0"/>
    <input name="transmission_weight" type="float" value="0"/><input name="geometry_opacity" type="float" value="1"/>
  </open_pbr_surface>
  <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;

// Connected transmission_color (from an image node): stays a conservative
// VSM caster, never a transmittance record (gate 6).
const openPbrConnectedTint = (fileName) => `<materialx version="1.39">
  <image name="tint" type="color3"><input name="file" type="filename" value="${fileName}"/></image>
  <open_pbr_surface name="surface" type="surfaceshader">
    <input name="base_weight" type="float" value="0"/><input name="specular_weight" type="float" value="0"/>
    <input name="transmission_weight" type="float" value="1"/>
    <input name="transmission_color" type="color3" nodename="tint"/>
    <input name="transmission_depth" type="float" value="0.1"/>
    <input name="geometry_opacity" type="float" value="1"/>
    <input name="geometry_thin_walled" type="boolean" value="true"/>
  </open_pbr_surface>
  <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;

// Minimal 1x1 PNG encoder for the connected-tint fixture (gate 6).
function crc32(buf) { let crc = 0xffffffff; for (const byte of buf) { let c = (crc ^ byte) & 255; for (let i = 0; i < 8; i++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const tag = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([tag, data]))); return Buffer.concat([len, tag, data, crc]); }
function png(rgb) { const raw = Buffer.from([0, ...rgb, 255]), header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6; return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }

// Shared page-side setup: compiles every {path, xml} material, builds the
// stage, opens a flat-black Scene view, and returns a `capture(point)`
// helper that reads the center pixel from a camera at point+(D,D,D) looking
// at point. Written once and stringified into each test's evaluate.
async function pageSetup(env, THREE, materialXmls, meshes, lightIntensity, files) {
  const D = 4; // must match the module-level D used to size geometry drops
  const docs = [];
  const materials = [];
  for (const { path, xml } of materialXmls) {
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const node = window.listDocRenderables(doc)[0]?.node;
    docs.push(doc);
    materials.push({ path, node });
  }
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:0;top:0;width:8px;height:8px;background:#000';
  document.body.appendChild(holder);
  const sunLight = { primPath: '/Sun', type: 'DistantLight', matrix: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1], intensity: lightIntensity, exposure: 0, color: [1, 1, 1] };
  const stage = { upAxis: 'Y', metersPerUnit: 1, meshes, materials, lights: [sunLight] };
  const h = await window.createMtlxSceneView({ container: holder, stage, files: files || [], version: '1.39.5' });
  h.setBackdrop('none');
  h.setEnvironment(window.makeFlatEnvironment([0, 0, 0]));
  h.setEnvExposure(0);
  h.setSkyVisibility(false);
  h.setAmbientOcclusionEnabled(false);
  h.setStageLightsEnabled?.(true);
  h.setShadowsEnabled(true);
  h.setPresentation({ enabled: true, bloom: false, antialias: false, samples: 0, persist: false });
  h.setSceneDisplayTransform('lin_rec709');
  const renderer = h.renderer;
  const capture = (point, size = 128) => {
    h.camera.position.set(point[0] + D, point[1] + D, point[2] + D);
    h.camera.up.set(0, 1, 0);
    h.camera.lookAt(point[0], point[1], point[2]);
    h.camera.aspect = 1; h.camera.updateProjectionMatrix(); h.camera.updateMatrixWorld(true);
    renderer.setPixelRatio(1); renderer.setSize(size, size, false);
    const target = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true,
    });
    renderer.setRenderTarget(target);
    h.renderNow();
    const half = Math.floor(size / 2);
    const px = new Float32Array(4);
    renderer.readRenderTargetPixels(target, half, half, 1, 1, px);
    const glError = renderer.getContext().getError();
    renderer.setRenderTarget(null);
    target.dispose();
    return { rgb: [px[0], px[1], px[2]], glError };
  };
  const capturePatch = (point, size, patch) => {
    h.camera.position.set(point[0] + D, point[1] + D, point[2] + D);
    h.camera.up.set(0, 1, 0);
    h.camera.lookAt(point[0], point[1], point[2]);
    h.camera.aspect = 1; h.camera.updateProjectionMatrix(); h.camera.updateMatrixWorld(true);
    renderer.setPixelRatio(1); renderer.setSize(size, size, false);
    const target = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true,
    });
    renderer.setRenderTarget(target);
    h.renderNow();
    const origin = Math.floor((size - patch) / 2);
    const buf = new Float32Array(patch * patch * 4);
    renderer.readRenderTargetPixels(target, origin, origin, patch, patch, buf);
    const glError = renderer.getContext().getError();
    renderer.setRenderTarget(null);
    target.dispose();
    const luma = [];
    for (let i = 0; i < buf.length; i += 4) luma.push(0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2]);
    const mean = luma.reduce((a, v) => a + v, 0) / luma.length;
    const variance = luma.reduce((a, v) => a + (v - mean) * (v - mean), 0) / luma.length;
    return { mean, variance, glError };
  };
  return { h, capture, capturePatch, docs };
}
test('@scene two thin sheets tint a shadow by depth order (nearest, then full product)', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const meshes = [
    quad('/ReceiverFront', '/White', -10, 0, 0, 1.5, 1.5),
    quad('/RedBetween', '/Red', 0, 3, 0, 1.2, 1.2),
    quad('/ReceiverBetween', '/White', 0, 0, 0, 1.5, 1.5),
    quad('/RedBehind', '/Red', 10, 6, 0, 1.2, 1.2),
    quad('/BlueBehind', '/Blue', 10, 3, 0, 1.2, 1.2),
    quad('/ReceiverBehind', '/White', 10, 0, 0, 1.5, 1.5),
  ];
  const materialXmls = [
    { path: '/White', xml: openPbrOpaqueWhite() },
    { path: '/Red', xml: openPbrThin([0.2, 1, 1]) },
    { path: '/Blue', xml: openPbrThin([1, 1, 0.1]) },
  ];
  const result = await page.evaluate(async ({ pageSetupSrc, materialXmls, meshes }) => {
    const pageSetup = eval('(' + pageSetupSrc + ')');
    const env = await window.getMxEnv(), THREE = window.THREE;
    const { h, capture, docs } = await pageSetup(env, THREE, materialXmls, meshes, 40, []);
    try {
      const front = capture([-10, 0, 0]);
      const between = capture([0, 0, 0]);
      const behind = capture([10, 0, 0]);
      return { front, between, behind, debug: h.__shadowDebug?.() };
    } finally { h.dispose(); docs.forEach((d) => d.delete()); }
  }, { pageSetupSrc: pageSetup.toString(), materialXmls, meshes });
  console.log('[light-transmittance:sheets]', JSON.stringify(result));
  expect(result.front.glError).toBe(0);
  expect(result.between.glError).toBe(0);
  expect(result.behind.glError).toBe(0);
  const ref = result.front.rgb;
  // Front: nothing occludes it, all three channels should agree with each
  // other (no false tint).
  expect(Math.abs(ref[0] - ref[1]) / ref[1]).toBeLessThan(0.02);
  expect(Math.abs(ref[2] - ref[1]) / ref[1]).toBeLessThan(0.02);
  const betweenRatio = result.between.rgb.map((v, i) => v / ref[i]);
  const behindRatio = result.behind.rgb.map((v, i) => v / ref[i]);
  const targetBetween = [0.2, 1, 1];
  const targetBehind = [0.2, 1, 0.1];
  for (let i = 0; i < 3; i++) {
    expect(betweenRatio[i], 'between channel ' + i).toBeCloseTo(targetBetween[i], 1);
    expect(Math.abs(betweenRatio[i] - targetBetween[i])).toBeLessThan(0.02 + 0.02 * targetBetween[i]);
    expect(Math.abs(behindRatio[i] - targetBehind[i])).toBeLessThan(0.02 + 0.02 * targetBehind[i]);
  }
});

test('@scene a solid slab attenuates by Beer-Lambert over its true light-path thickness', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const meshes = [
    quad('/ReceiverRef', '/White', -10, 0, 0, 1.5, 1.5),
    box('/SlabThick2', '/Slab', 0, 5, 0, 0.5, 1, 0.5), // spans y=[4,6], thickness 2
    quad('/ReceiverThick2', '/White', 0, 0, 0, 1.5, 1.5),
    box('/SlabThick1', '/Slab', 10, 4.5, 0, 0.5, 0.5, 0.5), // spans y=[4,5], thickness 1
    quad('/ReceiverThick1', '/White', 10, 0, 0, 1.5, 1.5),
  ];
  const materialXmls = [
    { path: '/White', xml: openPbrOpaqueWhite() },
    { path: '/Slab', xml: openPbrSolid(0.8, [0.5, 0.5, 0.5], 1) },
  ];
  const result = await page.evaluate(async ({ pageSetupSrc, materialXmls, meshes }) => {
    const pageSetup = eval('(' + pageSetupSrc + ')');
    const env = await window.getMxEnv(), THREE = window.THREE;
    const { h, capture, docs } = await pageSetup(env, THREE, materialXmls, meshes, 40, []);
    try {
      const ref = capture([-10, 0, 0]);
      const thick2 = capture([0, 0, 0]);
      const thick1 = capture([10, 0, 0]);
      return { ref, thick2, thick1 };
    } finally { h.dispose(); docs.forEach((d) => d.delete()); }
  }, { pageSetupSrc: pageSetup.toString(), materialXmls, meshes });
  console.log('[light-transmittance:solid]', JSON.stringify(result));
  expect(result.ref.glError).toBe(0);
  const ref = result.ref.rgb;
  const r2 = result.thick2.rgb.map((v, i) => v / ref[i]);
  const r1 = result.thick1.rgb.map((v, i) => v / ref[i]);
  // The box above spans 2 world units (y=[4,6]); Beer-Lambert over that
  // path: 0.8*2^-2 = 0.2. The 1-unit box (y=[4,5]) gives 0.8*2^-1 = 0.4.
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(r2[i] - 0.2)).toBeLessThan(0.05 * 0.2 + 0.02);
    expect(Math.abs(r1[i] - 0.4)).toBeLessThan(0.05 * 0.4 + 0.02);
  }
});

test('@scene an opacity-only sheet records an exact, non-dithered coverage fraction', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const meshes = [
    quad('/ReceiverRef', '/White', -10, 0, 0, 1.5, 1.5),
    quad('/Sheet', '/Half', 0, 3, 0, 1.4, 1.4),
    quad('/Receiver', '/White', 0, 0, 0, 1.8, 1.8),
  ];
  const materialXmls = [
    { path: '/White', xml: openPbrOpaqueWhite() },
    { path: '/Half', xml: openPbrThin([1, 1, 1], 0, 0.5) },
  ];
  const result = await page.evaluate(async ({ pageSetupSrc, materialXmls, meshes }) => {
    const pageSetup = eval('(' + pageSetupSrc + ')');
    const env = await window.getMxEnv(), THREE = window.THREE;
    const { h, capture, capturePatch, docs } = await pageSetup(env, THREE, materialXmls, meshes, 40, []);
    try {
      const ref = capture([-10, 0, 0]);
      const shadowed = capture([0, 0, 0]);
      const patch = capturePatch([0, 0, 0], 256, 16);
      return { ref, shadowed, patch };
    } finally { h.dispose(); docs.forEach((d) => d.delete()); }
  }, { pageSetupSrc: pageSetup.toString(), materialXmls, meshes });
  console.log('[light-transmittance:opacity]', JSON.stringify(result));
  expect(result.ref.glError).toBe(0);
  expect(result.patch.glError).toBe(0);
  const ratio = result.shadowed.rgb.map((v, i) => v / result.ref.rgb[i]);
  for (const r of ratio) expect(Math.abs(r - 0.5)).toBeLessThan(0.02);
  const normalizedVariance = result.patch.variance / Math.max(1e-9, result.patch.mean * result.patch.mean);
  expect(normalizedVariance).toBeLessThan(1e-4);
});

test('@scene an opaque non-transmitter stays a hard occluder', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const meshes = [
    quad('/ReceiverRef', '/White', -10, 0, 0, 1.5, 1.5),
    quad('/Occluder', '/Opaque', 0, 3, 0, 1.2, 1.2),
    quad('/Receiver', '/White', 0, 0, 0, 1.5, 1.5),
  ];
  const materialXmls = [
    { path: '/White', xml: openPbrOpaqueWhite() },
    { path: '/Opaque', xml: openPbrOpaqueOccluder() },
  ];
  const result = await page.evaluate(async ({ pageSetupSrc, materialXmls, meshes }) => {
    const pageSetup = eval('(' + pageSetupSrc + ')');
    const env = await window.getMxEnv(), THREE = window.THREE;
    const { h, capture, docs } = await pageSetup(env, THREE, materialXmls, meshes, 40, []);
    try {
      const ref = capture([-10, 0, 0]);
      const shadowed = capture([0, 0, 0]);
      return { ref, shadowed };
    } finally { h.dispose(); docs.forEach((d) => d.delete()); }
  }, { pageSetupSrc: pageSetup.toString(), materialXmls, meshes });
  console.log('[light-transmittance:opaque-control]', JSON.stringify(result));
  expect(result.ref.glError).toBe(0);
  const ratio = result.shadowed.rgb.map((v, i) => v / result.ref.rgb[i]);
  for (const r of ratio) expect(r).toBeLessThan(0.05);
});

test('@scene moving a transmitter updates its record within the next frame', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const meshes = [
    quad('/ReceiverRef', '/White', -10, 0, 0, 1.5, 1.5),
    quad('/Sheet', '/Red', 0, 3, 0, 1.2, 1.2),
    quad('/Receiver', '/White', 0, 0, 0, 1.5, 1.5),
  ];
  const materialXmls = [
    { path: '/White', xml: openPbrOpaqueWhite() },
    { path: '/Red', xml: openPbrThin([0.2, 1, 1]) },
  ];
  const result = await page.evaluate(async ({ pageSetupSrc, materialXmls, meshes }) => {
    const pageSetup = eval('(' + pageSetupSrc + ')');
    const env = await window.getMxEnv(), THREE = window.THREE;
    const { h, capture, docs } = await pageSetup(env, THREE, materialXmls, meshes, 40, []);
    try {
      const ref = capture([-10, 0, 0]);
      const before = capture([0, 0, 0]);
      // The renderer has no live light-mover API, and a DistantLight's own
      // position is never read for shadow fitting (only its direction is),
      // so translating the light would be a no-op here. Move the
      // transmitter mesh itself instead: this exercises the identical
      // "the per-frame record must not go stale" code path.
      const sheet = h.prims.find((p) => p.userData && p.userData.primPath === '/Sheet');
      // Scene meshes have matrixAutoUpdate off, so move the matrix itself.
      sheet.applyMatrix4(new THREE.Matrix4().makeTranslation(20, 0, 0));
      sheet.updateMatrixWorld(true);
      h.setShadowsEnabled(true); // unconditionally rebuilds the shadow map
      const after = capture([0, 0, 0]);
      return { ref, before, after };
    } finally { h.dispose(); docs.forEach((d) => d.delete()); }
  }, { pageSetupSrc: pageSetup.toString(), materialXmls, meshes });
  console.log('[light-transmittance:moved]', JSON.stringify(result));
  expect(result.ref.glError).toBe(0);
  const beforeRatio = result.before.rgb.map((v, i) => v / result.ref.rgb[i]);
  const afterRatio = result.after.rgb.map((v, i) => v / result.ref.rgb[i]);
  expect(Math.abs(beforeRatio[0] - 0.2)).toBeLessThan(0.05);
  for (const r of afterRatio) expect(Math.abs(r - 1)).toBeLessThan(0.05);
});

test('@scene a connected-tint transmitter stays a conservative VSM caster', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const meshes = [
    quad('/ReceiverRef', '/White', -10, 0, 0, 1.5, 1.5),
    quad('/Sheet', '/Connected', 0, 3, 0, 1.2, 1.2),
    quad('/Receiver', '/White', 0, 0, 0, 1.5, 1.5),
  ];
  const materialXmls = [
    { path: '/White', xml: openPbrOpaqueWhite() },
    { path: '/Connected', xml: openPbrConnectedTint('tint.png') },
  ];
  const files = [{ path: 'tint.png', data: png([64, 220, 90]) }];
  const result = await page.evaluate(async ({ pageSetupSrc, materialXmls, meshes, files }) => {
    const pageSetup = eval('(' + pageSetupSrc + ')');
    const env = await window.getMxEnv(), THREE = window.THREE;
    const fileObjs = files.map((f) => ({ path: f.path, data: new Uint8Array(f.data).buffer }));
    const { h, capture, docs } = await pageSetup(env, THREE, materialXmls, meshes, 40, fileObjs);
    try {
      const ref = capture([-10, 0, 0]);
      const shadowed = capture([0, 0, 0]);
      return { ref, shadowed, warnings: h.warnings.slice(), debug: h.__shadowDebug?.() };
    } finally { h.dispose(); docs.forEach((d) => d.delete()); }
  }, { pageSetupSrc: pageSetup.toString(), materialXmls, meshes, files: files.map((f) => ({ path: f.path, data: Array.from(f.data) })) });
  console.log('[light-transmittance:connected]', JSON.stringify({ ...result, warnings: result.warnings }));
  expect(result.ref.glError).toBe(0);
  const ratio = result.shadowed.rgb.map((v, i) => v / result.ref.rgb[i]);
  for (const r of ratio) expect(r).toBeLessThan(0.05);
  expect(result.warnings.some((w) => /conservative/i.test(w))).toBe(true);
  const cells = (result.debug && result.debug.transmittance && result.debug.transmittance.cells) || [];
  expect(cells.length).toBe(0);
});
