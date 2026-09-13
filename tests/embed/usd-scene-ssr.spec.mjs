// S3 witnesses: screen-space reflections (js/mtlx-engine.js
// patchScreenSpaceReflection, js/usd-scene-renderer.js applySsrHistory/
// captureSsrHistory/updateDepthPrepass).
//
// Fixture: a small emissive box hovers above a wide, smooth, dark plane.
// The plane is pure specular (black base, specular weight 1) so any
// brightness it shows beyond the flat environment's own IBL contribution
// has to come from SSR reflecting the box. The environment is a very dark
// (not literally zero) flat colour so an IBL-only pixel is a valid, finite,
// nonzero baseline instead of an ambiguous exact black.
//
// The analytic mirror pixel for a planar reflector: mirror the box centre
// across the plane (y -> -y here, plane is y=0) and project that virtual
// point with the SAME real camera. A pinhole camera's projection depends
// only on ray direction, and the ray from the camera to the virtual point
// crosses the real plane at exactly the point a perfect mirror would show
// the reflection, so both project to the same pixel.
import { test, expect } from './lib/test-base.mjs';

const RENDER_SIZE = 200;
const CAMERA_FOV_DEG = 60;
const CAMERA_POS = [0, 1, 4];
const CAMERA_TARGET = [0, 1, -3];
// Offset from the look-at target (not centered on it): a pure yaw orbit
// around a target that coincides with the box position would leave the
// box-to-plane mirror geometry perfectly symmetric and the analytic pixel
// would not move at all, which cannot exercise reprojection tracking. Kept
// modest so the reflection stays well clear of the screen-edge confidence
// fade (uv within 10% of a border), which would otherwise add noise.
const BOX_CENTER = [2, 1, -3];
const BOX_HALF = 0.3;
const PLANE_HALF = 8;
const ENV_COLOR = [0.05, 0.05, 0.05];
const EMISSION_LUMINANCE = 40;

const PLANE_XML = (roughness) => `<materialx version="1.39">
  <open_pbr_surface name="plane" type="surfaceshader">
    <input name="base_weight" type="float" value="0"/>
    <input name="base_color" type="color3" value="0,0,0"/>
    <input name="specular_weight" type="float" value="1"/>
    <input name="specular_roughness" type="float" value="${roughness}"/>
    <input name="specular_ior" type="float" value="1.5"/>
    <input name="geometry_opacity" type="float" value="1"/>
  </open_pbr_surface>
  <surfacematerial name="planeMat" type="material"><input name="surfaceshader" type="surfaceshader" nodename="plane"/></surfacematerial>
</materialx>`;

const EMITTER_XML = `<materialx version="1.39">
  <open_pbr_surface name="emitter" type="surfaceshader">
    <input name="base_weight" type="float" value="0"/>
    <input name="specular_weight" type="float" value="0"/>
    <input name="emission_luminance" type="float" value="${EMISSION_LUMINANCE}"/>
    <input name="emission_color" type="color3" value="1,1,1"/>
    <input name="geometry_opacity" type="float" value="1"/>
  </open_pbr_surface>
  <surfacematerial name="emitterMat" type="material"><input name="surfaceshader" type="surfaceshader" nodename="emitter"/></surfacematerial>
</materialx>`;

// Builds the plane+box stage for one plane roughness, runs a list of SSR
// "phases" (each rendered for two frames, since SSR needs one settled
// frame before its history is valid) against the SAME handle/camera, and
// reads back a luminance sample at the analytic mirror pixel, a baseline
// 40px away on the same row, and the frame's left edge on that row.
async function renderCase(page, { roughness = 0.05, phases, cameraPos = CAMERA_POS, cameraTarget = CAMERA_TARGET, orbitDeg = null } = {}) {
  return page.evaluate(async ({ planeXml, emitterXml, opts }) => {
    const { roughness, phases, cameraPos, cameraTarget, orbitDeg,
      renderSize, fovDeg, boxCenter, boxHalf, planeHalf, envColor } = opts;
    const THREE = window.THREE;
    const env = await window.getMxEnv();
    const docs = [];
    const compileMat = async (xml) => {
      const doc = env.mx.createDocument();
      await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
      if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
      docs.push(doc);
      return window.listDocRenderables(doc)[0]?.node;
    };
    const planeNode = await compileMat(planeXml);
    const emitterNode = await compileMat(emitterXml);

    const plane = {
      primPath: '/Plane', materialPath: '/PlaneMaterial',
      positions: new Float32Array([
        -planeHalf, 0, -planeHalf, planeHalf, 0, -planeHalf,
        planeHalf, 0, planeHalf, -planeHalf, 0, planeHalf,
      ]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    };
    const boxGeo = new THREE.BoxGeometry(2 * boxHalf, 2 * boxHalf, 2 * boxHalf);
    const boxPositions = new Float32Array(boxGeo.attributes.position.array);
    for (let i = 0; i < boxPositions.length; i += 3) {
      boxPositions[i] += boxCenter[0];
      boxPositions[i + 1] += boxCenter[1];
      boxPositions[i + 2] += boxCenter[2];
    }
    const box = {
      primPath: '/Box', materialPath: '/BoxMaterial',
      positions: boxPositions,
      normals: new Float32Array(boxGeo.attributes.normal.array),
      uvs: new Float32Array(boxGeo.attributes.uv.array),
      indices: new Uint32Array(boxGeo.index.array),
    };
    const stage = {
      upAxis: 'Y', metersPerUnit: 1,
      meshes: [plane, box],
      materials: [{ path: '/PlaneMaterial', node: planeNode }, { path: '/BoxMaterial', node: emitterNode }],
      lights: [],
    };
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px;background:#000';
    document.body.appendChild(holder);
    let handle = null;
    const result = { phases: [], glError: null, renderError: null };
    try {
      handle = await window.createMtlxSceneView({ container: holder, stage, version: '1.39.5' });
      handle.setBackdrop('none');
      handle.setEnvironment(window.makeFlatEnvironment(envColor));
      handle.setEnvExposure(1);
      handle.setSkyVisibility(false);
      handle.setAmbientOcclusionEnabled(false);
      handle.setShadowsEnabled(false);
      handle.setPresentation({ enabled: true, bloom: false, antialias: false, samples: 0, persist: false });
      handle.setSceneDisplayTransform('lin_rec709');
      const camera = handle.camera;
      camera.fov = fovDeg;
      camera.aspect = 1;
      camera.near = 0.05;
      camera.far = 50;
      const setCameraPose = (pos, target) => {
        camera.position.set(pos[0], pos[1], pos[2]);
        camera.up.set(0, 1, 0);
        camera.lookAt(target[0], target[1], target[2]);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
      };
      setCameraPose(cameraPos, cameraTarget);
      const renderer = handle.renderer;
      renderer.setPixelRatio(1);
      renderer.setSize(renderSize, renderSize, false);
      const target = new THREE.WebGLRenderTarget(renderSize, renderSize, {
        type: THREE.FloatType, format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
      });
      const gl = renderer.getContext();
      while (gl.getError() !== gl.NO_ERROR) { /* drain setup diagnostics */ }
      renderer.setRenderTarget(target);

      // Analytic mirror pixel (top-down pixel space: y grows downward).
      const mirrorPixel = (boxCenterWorld, cam) => {
        const mirrored = new THREE.Vector3(boxCenterWorld[0], -boxCenterWorld[1], boxCenterWorld[2]);
        const ndc = mirrored.clone().project(cam);
        return {
          x: (ndc.x * 0.5 + 0.5) * renderSize,
          yTop: (1 - (ndc.y * 0.5 + 0.5)) * renderSize,
        };
      };
      const inFrontOfCamera = (worldPoint, cam) => {
        cam.updateMatrixWorld();
        const view = worldPoint.clone().applyMatrix4(cam.matrixWorldInverse);
        return view.z < 0;
      };

      const lumWindow = (buffer, cx, cyTop, radius) => {
        let sum = 0, count = 0;
        const cxr = Math.round(cx), cyr = Math.round(cyTop);
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const x = cxr + dx, yTop = cyr + dy;
            if (x < 0 || x >= renderSize || yTop < 0 || yTop >= renderSize) continue;
            const yGl = renderSize - 1 - yTop;
            const idx = (yGl * renderSize + x) * 4;
            sum += 0.2126 * buffer[idx] + 0.7152 * buffer[idx + 1] + 0.0722 * buffer[idx + 2];
            count++;
          }
        }
        return count ? sum / count : NaN;
      };
      const isFiniteWindow = (buffer, cx, cyTop, radius) => {
        const cxr = Math.round(cx), cyr = Math.round(cyTop);
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const x = cxr + dx, yTop = cyr + dy;
            if (x < 0 || x >= renderSize || yTop < 0 || yTop >= renderSize) continue;
            const yGl = renderSize - 1 - yTop;
            const idx = (yGl * renderSize + x) * 4;
            if (![buffer[idx], buffer[idx + 1], buffer[idx + 2]].every(Number.isFinite)) return false;
          }
        }
        return true;
      };
      const centroid = (buffer, cx, cyTop, radius) => {
        const cxr = Math.round(cx), cyr = Math.round(cyTop);
        let sumW = 0, sumX = 0, sumY = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const x = cxr + dx, yTop = cyr + dy;
            if (x < 0 || x >= renderSize || yTop < 0 || yTop >= renderSize) continue;
            const yGl = renderSize - 1 - yTop;
            const idx = (yGl * renderSize + x) * 4;
            const l = 0.2126 * buffer[idx] + 0.7152 * buffer[idx + 1] + 0.0722 * buffer[idx + 2];
            sumW += l; sumX += l * x; sumY += l * yTop;
          }
        }
        return sumW > 0 ? { x: sumX / sumW, y: sumY / sumW } : null;
      };

      for (const phase of phases) {
        if (phase.orbitDeg != null) {
          // Orbit around the fixed lookAt target, at the same radius,
          // by rotating the camera-to-target offset around world +Y.
          const rad = phase.orbitDeg * Math.PI / 180;
          const off = new THREE.Vector3(cameraPos[0] - cameraTarget[0], cameraPos[1] - cameraTarget[1], cameraPos[2] - cameraTarget[2]);
          off.applyAxisAngle(new THREE.Vector3(0, 1, 0), rad);
          const newPos = [cameraTarget[0] + off.x, cameraTarget[1] + off.y, cameraTarget[2] + off.z];
          handle.setCamera({ position: newPos, target: cameraTarget });
          camera.updateProjectionMatrix();
        }
        if (typeof phase.ssrOn === 'boolean') handle.setScreenSpaceReflections(phase.ssrOn);
        if (phase.ssrStrength != null) handle.setScreenSpaceReflectionStrength(phase.ssrStrength);
        if (phase.ssrMaxRoughness != null) handle.setScreenSpaceReflectionMaxRoughness(phase.ssrMaxRoughness);
        handle.renderNow();
        handle.renderNow();
        const glErrorNow = gl.getError();
        const buffer = new Float32Array(renderSize * renderSize * 4);
        renderer.readRenderTargetPixels(target, 0, 0, renderSize, renderSize, buffer);
        const mp = mirrorPixel(boxCenter, camera);
        // Offset toward the frame centre so the baseline sample always
        // stays on the plane, regardless of which side the box sits on.
        const baselineDx = mp.x > renderSize / 2 ? -40 : 40;
        const reflection = lumWindow(buffer, mp.x, mp.yTop, 1);
        const baseline = lumWindow(buffer, mp.x + baselineDx, mp.yTop, 1);
        const edge = lumWindow(buffer, 2, mp.yTop, 1);
        const edgeFinite = isFiniteWindow(buffer, 2, mp.yTop, 1);
        const blob = centroid(buffer, mp.x, mp.yTop, 20);
        result.phases.push({
          reflection, baseline, edge, edgeFinite,
          mirrorPixel: { x: mp.x, yTop: mp.yTop },
          mirrorInFront: inFrontOfCamera(new THREE.Vector3(boxCenter[0], -boxCenter[1], boxCenter[2]), camera),
          centroid: blob,
          glError: glErrorNow,
          ssrState: handle.getScreenSpaceReflections(),
        });
      }
      target.dispose();
    } catch (e) {
      result.renderError = String((e && e.message) || e);
    } finally {
      if (handle) handle.dispose();
      holder.remove();
      docs.forEach((doc) => { try { doc.delete(); } catch (e) {} });
    }
    return result;
  }, {
    planeXml: PLANE_XML(roughness), emitterXml: EMITTER_XML,
    opts: {
      roughness, phases, cameraPos, cameraTarget, orbitDeg,
      renderSize: RENDER_SIZE, fovDeg: CAMERA_FOV_DEG,
      boxCenter: BOX_CENTER, boxHalf: BOX_HALF, planeHalf: PLANE_HALF, envColor: ENV_COLOR,
    },
  });
}

test('@scene SSR reflects the emissive box in the mirror plane and fades cleanly when disabled', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const result = await renderCase(page, {
    roughness: 0.05,
    phases: [{ ssrOn: true }, { ssrOn: false }],
  });
  expect(result.renderError).toBe(null);
  const [on, off] = result.phases;
  console.log('[ssr:on-off]', JSON.stringify({ on, off }));
  expect(on.glError).toBe(0);
  expect(off.glError).toBe(0);
  expect(on.mirrorInFront).toBe(true);
  expect(Number.isFinite(on.reflection)).toBe(true);
  expect(Number.isFinite(on.baseline)).toBe(true);
  expect(on.ssrState.enabled).toBe(true);
  expect(off.ssrState.enabled).toBe(false);
  // Mirror pixel must read far brighter than a plain patch of the same
  // plane once SSR is on.
  expect(on.reflection).toBeGreaterThan(4 * on.baseline);
  // With SSR off the mirror pixel drops back near the plain baseline.
  expect(off.reflection).toBeLessThan(on.reflection * 0.5);
  expect(off.reflection).toBeLessThan(4 * off.baseline);
  // Edge pixel: finite and not a bare zero (the flat environment fallback
  // is a small nonzero constant, never a NaN or an unshaded discard).
  expect(on.edgeFinite).toBe(true);
  expect(Number.isFinite(on.edge)).toBe(true);
  expect(on.edge).toBeGreaterThan(0);
});

test('@scene SSR contrast fades with roughness and matches SSR-off past the max-roughness cutoff', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const sharp = await renderCase(page, { roughness: 0.05, phases: [{ ssrOn: true }] });
  const half = await renderCase(page, { roughness: 0.5, phases: [{ ssrOn: true }] });
  // specular_roughness 0.75 -> GGX alpha 0.5625, above the default
  // u_ssrMaxRoughness (0.5), so the shader's early-out makes this
  // bit-for-bit the same as SSR off on the SAME handle.
  const atMax = await renderCase(page, { roughness: 0.75, phases: [{ ssrOn: true }, { ssrOn: false }] });
  expect(sharp.renderError).toBe(null);
  expect(half.renderError).toBe(null);
  expect(atMax.renderError).toBe(null);
  const sharpOn = sharp.phases[0], halfOn = half.phases[0];
  const [atMaxOn, atMaxOff] = atMax.phases;
  console.log('[ssr:roughness]', JSON.stringify({ sharpOn, halfOn, atMaxOn, atMaxOff }));
  const sharpContrast = sharpOn.reflection - sharpOn.baseline;
  const halfContrast = halfOn.reflection - halfOn.baseline;
  expect(sharpContrast).toBeGreaterThan(0);
  expect(halfContrast).toBeGreaterThan(0);
  // The confidence fade (contract step 27) and the FG albedo term both drop
  // with roughness, so the measured ratio is well under the naive 0.5 the
  // confidence term alone would give; bracket the observed range instead.
  expect(halfContrast).toBeLessThan(sharpContrast * 0.4);
  expect(halfContrast).toBeGreaterThan(sharpContrast * 0.1);
  const relDiff = Math.abs(atMaxOn.reflection - atMaxOff.reflection) / (atMaxOff.reflection + 1e-6);
  expect(relDiff).toBeLessThan(0.02);
});

test('@scene SSR reflection follows the camera after a small orbit', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const result = await renderCase(page, {
    roughness: 0.05,
    phases: [{ ssrOn: true }, { ssrOn: true, orbitDeg: 5 }],
  });
  expect(result.renderError).toBe(null);
  const [before, after] = result.phases;
  console.log('[ssr:orbit]', JSON.stringify({ before, after }));
  expect(after.glError).toBe(0);
  expect(after.mirrorInFront).toBe(true);
  expect(after.centroid).not.toBeNull();
  const dx = after.centroid.x - after.mirrorPixel.x;
  const dy = after.centroid.y - after.mirrorPixel.yTop;
  const offsetPx = Math.sqrt(dx * dx + dy * dy);
  // A little over the contract's 2px headline: the 16-step/4-bisection
  // raymarch is sub-pixel accurate but not exact, and a confidence-weighted
  // centroid over a GGX highlight is not a perfect point estimator either.
  expect(offsetPx).toBeLessThan(3);
});
