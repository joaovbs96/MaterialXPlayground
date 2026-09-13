// M2c witnesses: camera-visible refraction through a solid transmitter in
// the Scene's RGB-T peel path (js/mtlx-engine.js mx_scene_refraction,
// js/usd-scene-renderer.js u_peelRefractsScene classification).
//
// Fixture: a narrow-fov perspective camera (approximates orthographic, so
// every ray shares one incidence angle) looks at an emissive checkerboard
// backdrop through a closed OpenPBR box. RGB-T mode is the Scene default;
// environment is black so only C (emission + refraction) is ever nonzero.
//
// Shift measurement is analytic edge detection, not cross-correlation: a
// checker boundary is periodic, so correlating a template against a raw
// margin excerpt aliases against the wrong period unless the two happen to
// be separated by a whole number of periods. Instead this locates the
// checker edge nearest the box centre (sub-pixel, via linear interpolation
// at the midpoint luminance) and compares its column to where an UNBENT
// camera ray through that same boundary would land, computed from the real
// camera/backdrop geometry (ray-plane intersection plus a secant-method
// inverse). The difference is the shift in pixels, unambiguous as long as
// it stays under half a checker period, which it does by a wide margin here.
import { test, expect } from './lib/test-base.mjs';

const RENDER_SIZE = 256;
const CAMERA_FOV_DEG = 4;
const CAMERA_DISTANCE = 40;
const TILT_DEG = 30;
const BACKDROP_Z = -6;
const BACKDROP_HALF = 3.0;
const BOX_HALF_X = 0.45;
const BOX_HALF_Y = 1.0;
const CHECKER_SQUARE = 48; // canvas px; period (2 squares) exceeds any expected shift
const CANVAS_SIZE = 256;

const BOX_XML = ({ ior = 1.5, roughness = 0, thin = false } = {}) => `<materialx version="1.39">
  <open_pbr_surface name="box" type="surfaceshader">
    <input name="base_weight" type="float" value="0"/><input name="base_color" type="color3" value="0,0,0"/>
    <input name="base_metalness" type="float" value="0"/><input name="specular_weight" type="float" value="1"/>
    <input name="specular_ior" type="float" value="${ior}"/><input name="specular_roughness" type="float" value="${roughness}"/>
    <input name="transmission_weight" type="float" value="1"/><input name="transmission_color" type="color3" value="1,1,1"/>
    <input name="transmission_depth" type="float" value="10"/><input name="emission_luminance" type="float" value="0"/>
    <input name="emission_color" type="color3" value="0,0,0"/><input name="geometry_opacity" type="float" value="1"/>
    <input name="coat_weight" type="float" value="0"/><input name="fuzz_weight" type="float" value="0"/><input name="subsurface_weight" type="float" value="0"/>
    <input name="geometry_thin_walled" type="boolean" value="${thin}"/>
  </open_pbr_surface>
  <surfacematerial name="boxMat" type="material"><input name="surfaceshader" type="surfaceshader" nodename="box"/></surfacematerial>
</materialx>`;

const BACKDROP_XML = `<materialx version="1.39">
  <image name="checkerImg" type="color3"><input name="file" type="filename" value="checker.png"/></image>
  <open_pbr_surface name="backdrop" type="surfaceshader">
    <input name="base_weight" type="float" value="0"/>
    <input name="specular_weight" type="float" value="0"/>
    <input name="emission_luminance" type="float" value="1"/>
    <input name="emission_color" type="color3" nodename="checkerImg"/>
    <input name="geometry_opacity" type="float" value="1"/>
  </open_pbr_surface>
  <surfacematerial name="backdropMat" type="material"><input name="surfaceshader" type="surfaceshader" nodename="backdrop"/></surfacematerial>
</materialx>`;

// A small emissive quad, used as the "bright emitter" reflected in witness 7.
const EMITTER_XML = `<materialx version="1.39">
  <open_pbr_surface name="emitter" type="surfaceshader">
    <input name="base_weight" type="float" value="0"/><input name="specular_weight" type="float" value="0"/>
    <input name="emission_luminance" type="float" value="40"/>
    <input name="emission_color" type="color3" value="1,1,1"/>
    <input name="geometry_opacity" type="float" value="1"/>
  </open_pbr_surface>
  <surfacematerial name="emitterMat" type="material"><input name="surfaceshader" type="surfaceshader" nodename="emitter"/></surfacematerial>
</materialx>`;

// Builds the stage, camera and RGB-T render, returning a linear centre-row
// readback plus geometric info (box screen-column bounds, the measured
// checker shift, and world<->pixel scale via the real camera projection)
// needed for the witnesses below. Runs entirely inside the page; only plain
// data crosses back.
async function renderCase(page, { ior = 1.5, thickness = 0.5, roughness = 0, thin = false,
  tiltDeg = TILT_DEG, boxOffsetX = 0, boxHalfX = BOX_HALF_X, withEmitter = false, captureRefractsOff = false } = {}) {
  return page.evaluate(async ({ boxXml, backdropXml, emitterXml, opts, consts }) => {
    const { ior, thickness, roughness, thin, tiltDeg, boxOffsetX, boxHalfX, withEmitter, captureRefractsOff } = opts;
    const { renderSize, cameraFovDeg, cameraDistance, backdropZ, backdropHalf, boxHalfY, checkerSquare, canvasSize } = consts;
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
    const boxNode = await compileMat(boxXml);
    const backdropNode = await compileMat(backdropXml);
    const emitterNode = withEmitter ? await compileMat(emitterXml) : null;

    // Checker canvas, generated in-page: two mid-range luminances (avoids
    // clipping at either display extreme) with a period much larger than
    // any expected shift.
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = canvasSize;
    const ctx = canvas.getContext('2d');
    for (let y = 0; y < canvas.height; y += checkerSquare) {
      for (let x = 0; x < canvas.width; x += checkerSquare) {
        const dark = (((x / checkerSquare) | 0) + ((y / checkerSquare) | 0)) % 2 === 0;
        ctx.fillStyle = dark ? 'rgb(60,60,60)' : 'rgb(200,200,200)';
        ctx.fillRect(x, y, checkerSquare, checkerSquare);
      }
    }
    const checkerBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));

    const boxGeo = new THREE.BoxGeometry(2 * boxHalfX, 2 * boxHalfY, thickness);
    const boxPositions = new Float32Array(boxGeo.attributes.position.array);
    for (let i = 0; i < boxPositions.length; i += 3) boxPositions[i] += boxOffsetX;
    const box = {
      primPath: '/Box', materialPath: '/BoxMaterial',
      positions: boxPositions,
      normals: new Float32Array(boxGeo.attributes.normal.array),
      uvs: new Float32Array(boxGeo.attributes.uv.array),
      indices: new Uint32Array(boxGeo.index.array),
    };
    // The camera's centre ray is a straight line through the origin, so at
    // any world z it sits at x = z*tan(tiltDeg); with the camera this far
    // off-axis that offset (tens of units) dwarfs the box/backdrop extents,
    // so the backdrop must be re-centred there, not at world x=0.
    const backdropCenterX = backdropZ * Math.tan(tiltDeg * Math.PI / 180);
    const backdrop = {
      primPath: '/Backdrop', materialPath: '/BackdropMaterial',
      positions: new Float32Array([
        backdropCenterX - backdropHalf, -backdropHalf, backdropZ, backdropCenterX + backdropHalf, -backdropHalf, backdropZ,
        backdropCenterX + backdropHalf, backdropHalf, backdropZ, backdropCenterX - backdropHalf, backdropHalf, backdropZ,
      ]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    };
    const meshes = [backdrop, box];
    const materials = [{ path: '/BoxMaterial', node: boxNode }, { path: '/BackdropMaterial', node: backdropNode }];
    const lights = [];
    if (withEmitter) {
      const emitterHalf = 0.08;
      const ez = 4, ex = -3, ey = 2; // off to the side, above, in front of the camera
      meshes.push({
        primPath: '/Emitter', materialPath: '/EmitterMaterial',
        positions: new Float32Array([
          ex - emitterHalf, ey - emitterHalf, ez, ex + emitterHalf, ey - emitterHalf, ez,
          ex + emitterHalf, ey + emitterHalf, ez, ex - emitterHalf, ey + emitterHalf, ez,
        ]),
        normals: new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]),
        uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
      });
      materials.push({ path: '/EmitterMaterial', node: emitterNode });
    }
    const stage = { upAxis: 'Y', metersPerUnit: 1, meshes, materials, lights };
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:256px;height:256px;background:#000';
    document.body.appendChild(holder);
    let result = null;
    let handle = null;
    try {
      handle = await window.createMtlxSceneView({ container: holder, stage, files: [{ path: 'checker.png', data: checkerBlob }], version: '1.39.5' });
      handle.setBackdrop('none');
      handle.setEnvironment(window.makeFlatEnvironment([0, 0, 0]));
      handle.setEnvExposure(0);
      handle.setSkyVisibility(false);
      handle.setAmbientOcclusionEnabled(false);
      handle.setShadowsEnabled(false);
      handle.setPresentation({ enabled: true, bloom: false, antialias: false, samples: 0, persist: false });
      handle.setSceneDisplayTransform('lin_rec709');
      const camera = handle.camera;
      camera.fov = cameraFovDeg;
      camera.aspect = 1;
      camera.near = 1;
      camera.far = 200;
      const rad = tiltDeg * Math.PI / 180;
      camera.position.set(cameraDistance * Math.sin(rad), 0, cameraDistance * Math.cos(rad));
      camera.up.set(0, 1, 0);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      const renderer = handle.renderer;
      renderer.setPixelRatio(1);
      renderer.setSize(renderSize, renderSize, false);
      const target = new THREE.WebGLRenderTarget(renderSize, renderSize, {
        type: THREE.FloatType, format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
      });
      const gl = renderer.getContext();
      while (gl.getError() !== gl.NO_ERROR) { /* drain setup diagnostics before the measured render */ }
      renderer.setRenderTarget(target);
      handle.renderNow();
      const glError = gl.getError();

      // Row at world y=0 (screen-vertical centre, since the camera looks at
      // the origin with a level up vector): project(camera) gives the exact
      // pixel row this renderer would have written it to.
      const ndcRow = new THREE.Vector3(0, 0, 0).project(camera);
      const rowPx = Math.round((1 - (ndcRow.y * 0.5 + 0.5)) * renderSize);
      const rowY = Math.max(0, Math.min(renderSize - 1, target.height - 1 - rowPx));
      const rowBuffer = new Float32Array(renderSize * 4);
      renderer.readRenderTargetPixels(target, 0, rowY, renderSize, 1, rowBuffer);
      const row = new Array(renderSize);
      for (let x = 0; x < renderSize; x++) {
        row[x] = (rowBuffer[x * 4] + rowBuffer[x * 4 + 1] + rowBuffer[x * 4 + 2]) / 3;
      }

      // Exact miss baseline: the same solid material at the same pose with
      // u_peelRefractsScene forced to 0 on every material. A miss routes
      // tint into T exactly as that forced-off path does, so the two must
      // read identically; restore the real values afterward.
      let offRow = null;
      if (captureRefractsOff) {
        const dbgOff = handle.__debug();
        const saved = [];
        (dbgOff.materials || []).forEach((m) => {
          if (m && m.uniforms && m.uniforms.u_peelRefractsScene) {
            saved.push([m, m.uniforms.u_peelRefractsScene.value]);
            m.uniforms.u_peelRefractsScene.value = 0;
          }
        });
        renderer.setRenderTarget(target);
        handle.renderNow();
        const offBuffer = new Float32Array(renderSize * 4);
        renderer.readRenderTargetPixels(target, 0, rowY, renderSize, 1, offBuffer);
        offRow = new Array(renderSize);
        for (let x = 0; x < renderSize; x++) {
          offRow[x] = (offBuffer[x * 4] + offBuffer[x * 4 + 1] + offBuffer[x * 4 + 2]) / 3;
        }
        saved.forEach(([m, v]) => { m.uniforms.u_peelRefractsScene.value = v; });
      }

      // Box silhouette columns at world y=0: project both the front and
      // back face's left/right edges (world x = boxOffsetX +/- boxHalfX,
      // z = +/- thickness/2) and take the union, since an oblique camera can
      // make either face the silhouette edge.
      const toCol = (wx, wz) => {
        const ndc = new THREE.Vector3(wx, 0, wz).project(camera);
        return (ndc.x * 0.5 + 0.5) * renderSize;
      };
      const cols = [
        toCol(boxOffsetX - boxHalfX, thickness / 2), toCol(boxOffsetX + boxHalfX, thickness / 2),
        toCol(boxOffsetX - boxHalfX, -thickness / 2), toCol(boxOffsetX + boxHalfX, -thickness / 2),
      ];
      const boxColMin = Math.min(...cols), boxColMax = Math.max(...cols);

      // Pixel scale along the camera's own local +X (the tilt/incidence
      // plane's lateral axis): project two points 1 world unit apart along
      // it from a reference on the box's front face and measure the pixel
      // gap, so the conversion uses the SAME projection matrix as
      // everything else here.
      const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      const refPoint = new THREE.Vector3(boxOffsetX, 0, thickness / 2);
      const shifted = refPoint.clone().addScaledVector(camRight, 1);
      const s0 = refPoint.clone().project(camera), s1 = shifted.clone().project(camera);
      const pixelsPerWorldUnit = Math.abs((s1.x - s0.x) * 0.5 * renderSize);

      // Analytic exit-projection replica of mx_scene_refraction's entry
      // bend, per screen column: ray-plane intersect the box's own front
      // face to get the fragment position there, refract it, and project
      // the resulting exit point back to NDC. Used only to classify which
      // columns are expected to miss (exit leaves the frame); this stops
      // before the reach/uvS steps, which depend on the real depth buffer.
      const colToBoxFaceX = (col) => {
        const ndcX = (col / renderSize) * 2 - 1;
        const ndcY = 1 - 2 * (rowY / renderSize);
        const near = new THREE.Vector3(ndcX, ndcY, -1).unproject(camera);
        const far = new THREE.Vector3(ndcX, ndcY, 1).unproject(camera);
        const dir = far.clone().sub(near);
        const tParam = (thickness / 2 - near.z) / dir.z;
        return near.x + dir.x * tParam;
      };
      const exitLeavesFrame = (col) => {
        const fx = colToBoxFaceX(col);
        const fragPos = new THREE.Vector3(fx, 0, thickness / 2);
        const N = new THREE.Vector3(0, 0, 1);
        const V = camera.position.clone().sub(fragPos).normalize();
        const I = V.clone().negate();
        const eta = 1.0 / ior;
        const d = N.dot(I);
        const k = 1.0 - eta * eta * (1.0 - d * d);
        if (k < 0) return false; // TIR at entry: not an off-screen miss
        const dirIn = I.clone().multiplyScalar(eta).sub(N.clone().multiplyScalar(eta * d + Math.sqrt(k)));
        const denom = Math.max(Math.abs(dirIn.dot(N)), 1e-6);
        const t = thickness / denom;
        const Pexit = fragPos.clone().addScaledVector(dirIn, t);
        const ndc = Pexit.clone().project(camera);
        return !(ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1);
      };

      // Analytic shift measurement: colToBackdropX(col) is the world X an
      // UNBENT camera ray through screen column `col` (at this row) would
      // hit on the backdrop plane. A checker edge observed at column C, once
      // matched to its nearest boundary world X, should sit at
      // colToBackdropX^-1(boundaryX) if there is no shift; the difference
      // from the OBSERVED column C is the shift in pixels.
      const colToBackdropX = (col) => {
        const ndcX = (col / renderSize) * 2 - 1;
        const ndcY = 1 - 2 * (rowY / renderSize);
        const near = new THREE.Vector3(ndcX, ndcY, -1).unproject(camera);
        const far = new THREE.Vector3(ndcX, ndcY, 1).unproject(camera);
        const dir = far.clone().sub(near);
        const tParam = (backdropZ - near.z) / dir.z;
        return near.x + dir.x * tParam;
      };
      const invertColToX = (targetX) => {
        let c0 = 0, c1 = renderSize - 1;
        let x0 = colToBackdropX(c0), x1 = colToBackdropX(c1);
        for (let iter = 0; iter < 40; iter++) {
          const denom = (x1 - x0) || 1e-9;
          const cm = c0 + (targetX - x0) * (c1 - c0) / denom;
          const xm = colToBackdropX(cm);
          c0 = c1; x0 = x1; c1 = cm; x1 = xm;
          if (Math.abs(xm - targetX) < 1e-9) break;
        }
        return c1;
      };
      const squareWorldX = checkerSquare * (2 * backdropHalf / canvasSize);
      const midLevel = ((60 / 255) + (200 / 255)) / 2;
      const findEdgeCol = (start, end, step) => {
        for (let c = start; step > 0 ? c < end : c > end; c += step) {
          const a = row[c], b = row[c + step];
          if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
          if ((a - midLevel) * (b - midLevel) < 0) {
            const frac = (midLevel - a) / (b - a);
            return c + frac * step;
          }
        }
        return null;
      };
      const pad = 6;
      const searchLo = Math.max(0, Math.ceil(boxColMin) + pad);
      const searchHi = Math.min(renderSize - 2, Math.floor(boxColMax) - pad);
      const midCol = Math.round((searchLo + searchHi) / 2);
      const detectedEdgeCol = findEdgeCol(midCol, searchHi, 1) ?? findEdgeCol(midCol, searchLo, -1);
      // Checker boundaries land on canvas-pixel multiples of checkerSquare,
      // which is NOT centred on backdropCenterX (canvas centre generally
      // falls mid-square); the boundary grid's own origin is the backdrop's
      // left edge (canvas u=0).
      const backdropLeftX = backdropCenterX - backdropHalf;
      let shiftPx = null;
      if (detectedEdgeCol != null) {
        const worldXAtEdge = colToBackdropX(detectedEdgeCol);
        const boundaryIndex = Math.round((worldXAtEdge - backdropLeftX) / squareWorldX);
        const boundaryWorldX = backdropLeftX + boundaryIndex * squareWorldX;
        const expectedCol = invertColToX(boundaryWorldX);
        shiftPx = detectedEdgeCol - expectedCol;
      }

      let highlight = null;
      if (withEmitter) {
        // Brightest pixel strictly inside the box's own screen footprint
        // (its own reflection, not the checker or the emitter quad itself).
        const colStart = Math.max(0, Math.ceil(boxColMin) + 2);
        const colEnd = Math.min(renderSize - 1, Math.floor(boxColMax) - 2);
        let best = { x: -1, y: -1, value: -Infinity };
        const full = new Float32Array(renderSize * renderSize * 4);
        renderer.readRenderTargetPixels(target, 0, 0, renderSize, renderSize, full);
        for (let y = 0; y < renderSize; y++) {
          for (let x = colStart; x <= colEnd; x++) {
            const idx = (y * renderSize + x) * 4;
            const v = full[idx] + full[idx + 1] + full[idx + 2];
            if (v > best.value) best = { x, y, value: v };
          }
        }
        highlight = best;
      }

      const hasNaN = row.some((v) => !Number.isFinite(v));
      const missExpected = new Array(renderSize).fill(false);
      for (let x = Math.max(0, Math.floor(boxColMin)); x <= Math.min(renderSize - 1, Math.ceil(boxColMax)); x++) {
        missExpected[x] = exitLeavesFrame(x);
      }
      result = { row, offRow, boxColMin, boxColMax, pixelsPerWorldUnit, glError, hasNaN, shiftPx, highlight, missExpected };
    } finally {
      if (handle) handle.dispose();
      holder.remove();
      docs.forEach((doc) => { try { doc.delete(); } catch (e) {} });
    }
    return result;
  }, {
    boxXml: BOX_XML({ ior, roughness, thin }), backdropXml: BACKDROP_XML, emitterXml: EMITTER_XML,
    opts: { ior, thickness, roughness, thin, tiltDeg, boxOffsetX, boxHalfX, withEmitter, captureRefractsOff },
    consts: {
      renderSize: RENDER_SIZE, cameraFovDeg: CAMERA_FOV_DEG, cameraDistance: CAMERA_DISTANCE,
      backdropZ: BACKDROP_Z, backdropHalf: BACKDROP_HALF, boxHalfY: BOX_HALF_Y,
      checkerSquare: CHECKER_SQUARE, canvasSize: CANVAS_SIZE,
    },
  });
}

test('@scene refraction IOR 1.0 shows no checker shift at either thickness', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  for (const thickness of [0.5, 1.0]) {
    const result = await renderCase(page, { ior: 1.0, thickness });
    expect(result.glError, `thickness ${thickness}`).toBe(0);
    expect(result.hasNaN, `thickness ${thickness}`).toBe(false);
    expect(result.shiftPx, `thickness ${thickness} edge detected`).not.toBeNull();
    console.log('[refraction:ior1]', JSON.stringify({ thickness, shiftPx: result.shiftPx }));
    expect(Math.abs(result.shiftPx), `IOR 1.0 thickness ${thickness} shift`).toBeLessThan(1);
  }
});

test('@scene refraction IOR 1.5 matches the analytic thin-slab displacement and doubles with thickness', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const thetaI = TILT_DEG * Math.PI / 180;
  const ior = 1.5;
  const thetaT = Math.asin(Math.sin(thetaI) / ior);
  const measured = {};
  for (const thickness of [0.5, 1.0]) {
    const result = await renderCase(page, { ior, thickness });
    expect(result.glError, `thickness ${thickness}`).toBe(0);
    expect(result.hasNaN, `thickness ${thickness}`).toBe(false);
    expect(result.shiftPx, `thickness ${thickness} edge detected`).not.toBeNull();
    const analyticD = thickness * Math.sin(thetaI - thetaT) / Math.cos(thetaT);
    const expectedPx = analyticD * result.pixelsPerWorldUnit;
    measured[thickness] = { shiftPx: result.shiftPx, expectedPx };
    console.log('[refraction:ior1.5]', JSON.stringify({ thickness, shiftPx: result.shiftPx, expectedPx }));
    expect(Math.abs(Math.abs(result.shiftPx) - expectedPx), `thickness ${thickness} vs analytic`).toBeLessThan(0.2 * expectedPx + 0.5);
  }
  const ratio = Math.abs(measured[1.0].shiftPx) / Math.abs(measured[0.5].shiftPx || 1e-6);
  console.log('[refraction:doubling]', JSON.stringify({ ratio }));
  expect(ratio, 'thickness 1.0 shift should double thickness 0.5 shift').toBeGreaterThan(1.6);
  expect(ratio).toBeLessThan(2.4);
});

test('@scene refraction never displaces a thin-walled box', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const result = await renderCase(page, { ior: 1.5, thickness: 0.5, thin: true });
  expect(result.glError).toBe(0);
  expect(result.hasNaN).toBe(false);
  expect(result.shiftPx).not.toBeNull();
  console.log('[refraction:thin]', JSON.stringify({ shiftPx: result.shiftPx }));
  expect(Math.abs(result.shiftPx)).toBeLessThan(1);
});

test('@scene refraction roughness blurs the checker contrast without moving the box edges', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const sharp = await renderCase(page, { ior: 1.5, thickness: 0.5, roughness: 0 });
  // alpha (GGX roughness^2) drives the lod; 0.5 only reaches lod~2 of 8
  // (checkerSquare is 48px, so a 4-texel box barely dents contrast over the
  // measured window), so use the top of the range for an unambiguous drop.
  const blurred = await renderCase(page, { ior: 1.5, thickness: 0.5, roughness: 1.0 });
  expect(sharp.glError).toBe(0);
  expect(blurred.glError).toBe(0);
  expect(sharp.hasNaN).toBe(false);
  expect(blurred.hasNaN).toBe(false);
  const contrast = (result) => {
    const throughStart = Math.max(0, Math.ceil(result.boxColMin) + 4);
    const throughEnd = Math.min(result.row.length, Math.floor(result.boxColMax) - 4);
    const seg = result.row.slice(throughStart, throughEnd);
    const mean = seg.reduce((a, b) => a + b, 0) / seg.length;
    return Math.sqrt(seg.reduce((a, b) => a + (b - mean) * (b - mean), 0) / seg.length);
  };
  const sharpContrast = contrast(sharp), blurredContrast = contrast(blurred);
  console.log('[refraction:blur]', JSON.stringify({ sharpContrast, blurredContrast }));
  expect(blurredContrast, 'rough box should show lower checker contrast than a sharp one').toBeLessThan(sharpContrast * 0.9);
  expect(Math.abs(sharp.boxColMin - blurred.boxColMin), 'box edges unchanged by roughness').toBeLessThan(0.5);
  expect(Math.abs(sharp.boxColMax - blurred.boxColMax), 'box edges unchanged by roughness').toBeLessThan(0.5);
});

test('@scene refraction falls back to the environment term at the frame edge, never black or NaN', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  // A narrow box positioned so its visible remnant sits near the frame edge.
  const pose = { thickness: 1.0, boxOffsetX: 1.75, boxHalfX: 0.1, ior: 1.5 };
  const result = await renderCase(page, { ...pose, captureRefractsOff: true });
  expect(result.glError).toBe(0);
  expect(result.hasNaN).toBe(false);
  const colStart = Math.max(0, Math.ceil(result.boxColMin) + 2);
  const colEnd = Math.min(result.row.length - 1, Math.floor(result.boxColMax) - 2);
  const inside = result.row.slice(colStart, colEnd + 1);
  const offInside = result.offRow.slice(colStart, colEnd + 1);
  expect(inside.length, 'box must still have visible columns to check').toBeGreaterThan(4);
  expect(inside.every((v) => Number.isFinite(v))).toBe(true);
  expect(offInside.every((v) => Number.isFinite(v))).toBe(true);
  expect(inside.every((v) => v > 0.001), 'no pixel inside the box should read as black').toBe(true);
  expect(offInside.every((v) => v > 0.001), 'no pixel in the forced-off render should read as black').toBe(true);
  // Only compare columns whose analytic exit projection actually leaves the
  // frame: a miss routes tint into T exactly as forcing u_peelRefractsScene
  // to 0 does, so on and off must agree there. Columns that still hit
  // legitimately show different (correctly displaced) content in each render.
  const missCols = [];
  for (let c = colStart; c <= colEnd; c++) if (result.missExpected[c]) missCols.push(c);
  const relDiffs = missCols.map((c) => Math.abs(result.row[c] - result.offRow[c]) / (result.offRow[c] + 0.001));
  const maxRelDiff = relDiffs.length ? Math.max(...relDiffs) : null;
  console.log('[refraction:edge]', JSON.stringify({ boxColMin: result.boxColMin, boxColMax: result.boxColMax, missCols, on: missCols.map((c) => result.row[c]), off: missCols.map((c) => result.offRow[c]), maxRelDiff }));
  expect(missCols.length, 'at least one column must analytically leave the frame').toBeGreaterThan(0);
  expect(maxRelDiff, 'a miss must match the same pose with refraction forced off within 2%').toBeLessThan(0.02);
});

test('@scene refraction leaves the reflection highlight position untouched', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  // IOR 1.0 gives zero Fresnel reflectance (matched index), so a literal
  // IOR-1.0-vs-1.5 highlight comparison is physically vacuous; compare
  // instead whether refraction being active (solid) vs inactive (thin,
  // same IOR/Fresnel) leaves the untouched reflection closure's highlight
  // in the same place, which is what this witness is actually guarding.
  const solid = await renderCase(page, { ior: 1.5, thickness: 0.5, roughness: 0, withEmitter: true });
  const thin = await renderCase(page, { ior: 1.5, thickness: 0.5, roughness: 0, thin: true, withEmitter: true });
  expect(solid.glError).toBe(0);
  expect(thin.glError).toBe(0);
  console.log('[refraction:highlight]', JSON.stringify({ solid: solid.highlight, thin: thin.highlight }));
  expect(solid.highlight.value, 'a highlight should be visible').toBeGreaterThan(0.5);
  expect(thin.highlight.value, 'a highlight should be visible').toBeGreaterThan(0.5);
  expect(Math.abs(solid.highlight.x - thin.highlight.x)).toBeLessThan(2);
  expect(Math.abs(solid.highlight.y - thin.highlight.y)).toBeLessThan(2);
});
