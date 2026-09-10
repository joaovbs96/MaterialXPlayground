import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

// This fixture is deliberately small and analytic: a horizontal receiver and
// one raised rectangular blocker between it and a local rect emitter.  The
// profile is sampled on the receiver in world space, so a test can compare
// source size, orientation, and scale without depending on arbitrary screen
// coordinates.
const MATERIAL_XML = `<materialx version="1.39">
  <constant name="albedo" type="color3"><input name="value" type="color3" value="0.8, 0.8, 0.8"/></constant>
  <standard_surface name="surface" type="surfaceshader">
    <input name="base" type="float" value="1"/>
    <input name="base_color" type="color3" nodename="albedo"/>
    <input name="specular" type="float" value="0"/>
    <input name="transmission" type="float" value="0"/>
    <input name="emission" type="float" value="0"/>
  </standard_surface>
  <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;

function lumaAt(image, point) {
  const x = Math.max(0, Math.min(image.width - 1, Math.round(point[0] * image.width)));
  const y = Math.max(0, Math.min(image.height - 1, Math.round(point[1] * image.height)));
  const p = image.getPixel(x, y);
  return (0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b) / 255;
}

function decode(data) {
  return decodePNG(Buffer.from(data.split(',')[1], 'base64'));
}

async function renderProfile(page, options) {
  const result = await page.evaluate(async ({ xml, extent, scale, rotation }) => {
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const node = window.listDocRenderables(doc)[0].node;
    const THREE = window.THREE;
    const rot = new THREE.Matrix4().makeRotationY(rotation);
    const transform = (x, y, z) => new THREE.Vector3(x * scale, y * scale, z * scale).applyMatrix4(rot);
    const receiverLocal = [
      [-1.5, 0, -2], [1.5, 0, -2], [1.5, 0, 2], [-1.5, 0, 2],
    ];
    const blockerLocal = [
      [-0.3, 0, 1.0], [0.3, 0, 1.0], [0.3, 1.1, 1.0], [-0.3, 1.1, 1.0],
      [-0.3, 0, 1.6], [0.3, 0, 1.6], [0.3, 1.1, 1.6], [-0.3, 1.1, 1.6],
    ];
    const packed = (points) => new Float32Array(points.flatMap(([x, y, z]) => transform(x, y, z).toArray()));
    const receiver = {
      primPath: '/Receiver', name: 'Receiver', materialPath: '/Material',
      positions: packed(receiverLocal),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      // Counter-clockwise from above, matching the +Y normals.
      indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
    };
    const blocker = {
      primPath: '/Blocker', name: 'Blocker', materialPath: '/Material',
      positions: packed(blockerLocal), normals: new Float32Array(24),
      indices: new Uint32Array([
        0, 1, 2, 0, 2, 3, 5, 4, 7, 5, 7, 6,
        4, 0, 3, 4, 3, 7, 1, 5, 6, 1, 6, 2,
        3, 2, 6, 3, 6, 7, 4, 5, 1, 4, 1, 0,
      ]),
    };
    // UsdLux emitters point down their local -Z axis.  This basis sends -Z
    // down and toward +Z, placing the blocker in a detached ground shadow.
    const lightPose = new THREE.Matrix4().fromArray([
      1, 0, 0, 0,
      0, 0.7071068, 0.7071068, 0,
      0, 0.7071068, -0.7071068, 0,
      0, 4, -1.5, 1,
    ]);
    lightPose.multiplyMatrices(rot, lightPose);
    const lightPosition = transform(0, 4, -1.5);
    lightPose.setPosition(lightPosition);
    const stage = {
      upAxis: 'Y', metersPerUnit: 1,
      meshes: [receiver, blocker],
      materials: [{ path: '/Material', node }],
      lights: [{ primPath: '/ProfileRect', type: 'RectLight', matrix: lightPose.toArray(),
        // Keep the non-normalized source radiance high enough that the
        // .01-scaled fixture still survives an 8-bit canvas readback.  The
        // inverse-square falloff cancels the area loss under uniform scale.
        intensity: 500000, exposure: 0, color: [1, 1, 1],
        width: extent * scale, height: extent * scale, normalize: false }],
    };
    const holder = document.createElement('div');
    holder.dataset.testid = 'soft-shadow-profile-canvas';
    holder.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:480px;background:#000';
    document.body.appendChild(holder);
    const handle = await window.createMtlxSceneView({ container: holder, stage, version: '1.39.5' });
    handle.setBackdrop('none');
    handle.setEnvironment(window.makeFlatEnvironment([0, 0, 0]));
    handle.setEnvExposure(0);
    handle.setSkyVisibility(false);
    handle.setAmbientOcclusionEnabled(false);
    handle.setStageLightsEnabled(true);
    handle.setSceneDisplayTransform('lin_rec709');
    // Keep the complete receiver in view at every uniform scale.  A closer
    // camera would crop the sample line after scaling even though the scene
    // itself is geometrically identical.
    const cameraPosition = transform(0, 2.5, 1.9);
    const cameraUp = new THREE.Vector3(0, 0, -1).applyMatrix4(rot);
    handle.camera.position.copy(cameraPosition);
    handle.camera.up.copy(cameraUp);
    handle.camera.near = Math.max(1e-6, scale * 0.001);
    handle.camera.far = Math.max(scale * 100, 10);
    handle.setCamera({ position: cameraPosition.toArray(), target: transform(0, 0, 1.9).toArray() });
    handle.camera.updateProjectionMatrix();
    handle.camera.updateMatrixWorld(true);
    handle.setShadowsEnabled(false);
    handle.renderNow();
    // The canvas is kept as a real display readback, but its 8-bit floor is
    // too coarse for the .01-scale fixture.  Read the same untouched Scene
    // material into a float target as the optical measurement; this remains
    // the production renderer and shader path, with no source swapping.
    const readFloat = (points, clearPoint) => {
      const size = handle.renderer.getDrawingBufferSize(new THREE.Vector2());
      const target = new THREE.WebGLRenderTarget(size.x, size.y, {
        format: THREE.RGBAFormat, type: THREE.FloatType,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        depthBuffer: true, stencilBuffer: false,
      });
      const pixels = new Float32Array(size.x * size.y * 4);
      const previous = handle.renderer.getRenderTarget();
      handle.renderer.setRenderTarget(target);
      handle.renderer.setViewport(0, 0, size.x, size.y);
      handle.renderer.clear();
      handle.renderer.render(handle.scene, handle.camera);
      handle.renderer.readRenderTargetPixels(target, 0, 0, size.x, size.y, pixels);
      handle.renderer.setRenderTarget(previous);
      target.dispose();
      const sample = (point) => {
        const x = Math.max(0, Math.min(size.x - 1, Math.round(point[0] * size.x)));
        const y = Math.max(0, Math.min(size.y - 1, Math.round(point[1] * size.y)));
        const o = ((size.y - 1 - y) * size.x + x) * 4;
        return 0.2126 * pixels[o] + 0.7152 * pixels[o + 1] + 0.0722 * pixels[o + 2];
      };
      return { samples: points.map(sample), clear: sample(clearPoint) };
    };
    const project = (x, y, z) => {
      const p = transform(x, y, z).addScaledVector(cameraUp, 1e-4 * scale).project(handle.camera);
      return [p.x * 0.5 + 0.5, -p.y * 0.5 + 0.5];
    };
    // The line crosses the detached shadow in local x.  The clear reference
    // sits on the same receiver and is outside the blocker projection.
    const samples = Array.from({ length: 241 }, (_, i) => -0.6 + i * 0.005)
      .map((x) => project(x, 0, 1.9));
    // Keep the clear reference on the same receiver scanline.  This removes
    // the source-cosine and inverse-square differences that a second depth
    // location would introduce.
    const clear = project(-0.8, 0, 1.9);
    const off = holder.querySelector('canvas').toDataURL('image/png');
    const offFloat = readFloat(samples, clear);
    handle.setShadowsEnabled(true);
    handle.renderNow();
    const on = holder.querySelector('canvas').toDataURL('image/png');
    const onFloat = readFloat(samples, clear);
    const debug = handle.__shadowDebug();
    const receiverPoint = transform(0, 0, 1.9);
    const blockerPoint = transform(0, 1.1, 1.0);
    const tile = debug.tiles[0];
    // Perspective Z is measured along the actual shadow camera forward axis,
    // which can differ substantially from the source-to-receiver ray for a
    // wide local-light frustum.
    const shadowCameraPosition = new THREE.Vector3().fromArray(tile.cameraPosition);
    const shadowAim = new THREE.Vector3().fromArray(tile.aim);
    const shadowForward = shadowAim.sub(shadowCameraPosition).normalize();
    const receiverZ = receiverPoint.clone().sub(shadowCameraPosition).dot(shadowForward);
    const blockerZ = blockerPoint.clone().sub(shadowCameraPosition).dot(shadowForward);
    const filterWorldRadius = extent * scale * 0.5 * Math.max(0, receiverZ - blockerZ) / Math.max(blockerZ, 1e-6);
    const filterTexels = tile && tile.projectionScale
      ? filterWorldRadius * tile.projectionScale[0] / (2 * Math.max(receiverZ, 1e-6)) * 1024 : null;
    const compiled = handle.prims.some((object) => object.material?.userData?.mtlxSceneCompiled?.fs);
    const warnings = handle.warnings.slice();
    handle.dispose();
    holder.remove();
    doc.delete();
    return { off, on, samples, clear, debug, compiled, warnings, offFloat, onFloat,
      receiverZ, blockerZ, filterTexels };
  }, { xml: MATERIAL_XML, ...options });
  const off = decode(result.off);
  const on = decode(result.on);
  const raw = result.onFloat.samples;
  const offRaw = result.offFloat.samples;
  const clearOn = result.onFloat.clear;
  const clearOff = result.offFloat.clear;
  return {
    ...result,
    raw,
    // Per-pixel ON/OFF normalization measures visibility, removing the
    // source-cosine and inverse-square brightness from the profile.  This is
    // essential for comparing the same non-normalized lamp at .01 scale.
    normalized: raw.map((value, i) => value / Math.max(offRaw[i], 1e-6)),
    clearOn,
    clearOff,
    canvasClearOn: lumaAt(on, result.clear),
    canvasClearOff: lumaAt(off, result.clear),
  };
}

test('@scene finite source shadow profile responds to extent, rotation, and uniform scale', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });

  const point = await renderProfile(page, { extent: 0.01, scale: 1, rotation: 0 });
  const broad = await renderProfile(page, { extent: 0.05, scale: 1, rotation: 0 });
  const rotated = await renderProfile(page, { extent: 0.05, scale: 1, rotation: Math.PI / 2 });
  const scaled = await renderProfile(page, { extent: 0.05, scale: 0.01, rotation: 0 });
  console.log('[soft-shadow-profile]', JSON.stringify({
    point: { transition: point.normalized.filter((v) => v > 0.08 && v < 0.92).length,
      min: Math.min(...point.normalized), max: Math.max(...point.normalized) },
    broad: { transition: broad.normalized.filter((v) => v > 0.08 && v < 0.92).length,
      min: Math.min(...broad.normalized), max: Math.max(...broad.normalized) },
    rotated: { transition: rotated.normalized.filter((v) => v > 0.08 && v < 0.92).length },
    scaled: { transition: scaled.normalized.filter((v) => v > 0.08 && v < 0.92).length },
    clear: [point.clearOn, broad.clearOn, rotated.clearOn, scaled.clearOn],
    tiles: [point.debug.tiles[0], broad.debug.tiles[0]],
    scaledTile: scaled.debug.tiles[0],
  }));

  for (const result of [point, broad, rotated, scaled]) {
    expect(result.compiled).toBe(true);
    expect(result.debug.casters).toBeGreaterThan(0);
    expect(result.debug.tiles[0].caster).toBe('/ProfileRect');
    expect(result.debug.tiles[0].sourceKind).toBe(1);
    expect(result.clearOn).toBeGreaterThan(1e-4);
    expect(result.clearOn).toBeGreaterThan(result.clearOff * 0.95);
    expect(result.canvasClearOn).toBeGreaterThan(0);
    expect(result.warnings.some((warning) => /compile failed|unsupported material/i.test(warning))).toBe(false);
  }

    // The source sizes are deliberately small: the broad source's measured
    // projected filter footprint is below the implementation's two-texel
    // safety cap. A disabled/constant filter therefore produces the same
    // profile and fails this assertion.
  const pointTransition = point.normalized.filter((v) => v > 0.08 && v < 0.92).length;
  const broadTransition = broad.normalized.filter((v) => v > 0.08 && v < 0.92).length;
  // The actual receiver/blocker distances predict a broad filter footprint
  // below two shadow-map texels.  The conservative blocker search may still
  // reach its cap; this assertion is about the measured penumbra filter.
  expect(point.filterTexels).toBeGreaterThan(0);
  expect(broad.filterTexels).toBeGreaterThan(point.filterTexels);
  expect(broad.filterTexels).toBeLessThan(2);
  expect(broadTransition).toBeGreaterThan(pointTransition);
  expect(point.normalized[0]).toBeGreaterThan(0.6);
  expect(broad.normalized[0]).toBeGreaterThan(0.6);
  const center = Math.floor(point.normalized.length / 2);
  expect(point.normalized[center]).toBeLessThan(0.35);
  expect(broad.normalized[center]).toBeLessThan(0.35);
  expect(Math.min(...point.normalized)).toBeLessThan(0.35);
  expect(Math.min(...broad.normalized)).toBeLessThan(0.35);

  // Rotating the complete fixture and camera must preserve the local profile.
  for (let i = 0; i < broad.normalized.length; i++) {
    expect(rotated.normalized[i]).toBeCloseTo(broad.normalized[i], 1);
  }

  // The non-normalized stage light keeps its authored intensity while all
  // world dimensions, including the rect, scale by .01.  Ratios to the clear
  // receiver remove the absolute brightness and test angular invariance.
  for (let i = 0; i < broad.normalized.length; i++) {
    expect(scaled.normalized[i]).toBeCloseTo(broad.normalized[i], 1);
  }
  // The physical falloff path keeps clear-receiver irradiance invariant under
  // uniform scaling even though the authored lamp intensity is unchanged.
  expect(scaled.clearOff).toBeCloseTo(broad.clearOff, 2);
});
