import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';

const openPbrPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'materials', 'open_pbr_default.mtlx');
const OPAQUE_XML = fs.readFileSync(openPbrPath, 'utf8');
// Constant geometry_opacity=0 is the "clear" classification path.
const CLEAR_XML = OPAQUE_XML.replace(/(<input name="geometry_opacity" type="float" value=")[^"]+(")/, '$10$2');

// A box's front face (toward the +z camera) sits at cz + hz; every point on
// that face shares one view-space z since the camera looks straight down -Z.
function boxMesh(primPath, materialPath, cx, cy, cz, hx, hy, hz) {
  const positions = new Float32Array([
    cx - hx, cy - hy, cz - hz, cx + hx, cy - hy, cz - hz, cx + hx, cy + hy, cz - hz, cx - hx, cy + hy, cz - hz,
    cx - hx, cy - hy, cz + hz, cx + hx, cy - hy, cz + hz, cx + hx, cy + hy, cz + hz, cx - hx, cy + hy, cz + hz,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
  ]);
  return { primPath, materialPath, positions, normals: null, uvs: null, indices };
}

// Receiver front face at z=0, spans x in [-1.5, 0.9]; the clear boxes sit
// at z=0.3 and the opaque box at z=0.5 (both nearer the camera), so a
// single frame exercises all three depth outcomes at once.
const RECEIVER = boxMesh('/Receiver', '/MatOpaque', -0.3, 0, -0.05, 1.2, 1.0, 0.05);
const OPAQUE_BOX = boxMesh('/OpaqueBox', '/MatOpaque', -0.9, 0, 0.45, 0.25, 0.4, 0.05);
const CLEAR_OVER_RECEIVER = boxMesh('/ClearOverReceiver', '/MatClear', 0.3, 0, 0.25, 0.25, 0.4, 0.05);
const CLEAR_OVER_BACKGROUND = boxMesh('/ClearOverBackground', '/MatClear', 1.3, 0, 0.25, 0.25, 0.4, 0.05);

const STAGE = {
  upAxis: 'Y', metersPerUnit: 1,
  meshes: [RECEIVER, OPAQUE_BOX, CLEAR_OVER_RECEIVER, CLEAR_OVER_BACKGROUND],
  materials: [{ path: '/MatOpaque', node: null }, { path: '/MatClear', node: null }],
  lights: [{ primPath: '/Key', type: 'PointLight', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3, 4, 1], intensity: 15, exposure: 0, color: [1, 1, 1] }],
};

test('@scene a zero-opacity surface leaves opaque depth untouched behind it', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const result = await page.evaluate(async ({ opaqueXml, clearXml, stage }) => {
    const env = await window.getMxEnv();
    const docOpaque = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(docOpaque, opaqueXml));
    if (docOpaque.setDataLibrary) docOpaque.setDataLibrary(env.stdlib);
    const docClear = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(docClear, clearXml));
    if (docClear.setDataLibrary) docClear.setDataLibrary(env.stdlib);
    stage.materials[0].node = window.listDocRenderables(docOpaque)[0].node;
    stage.materials[1].node = window.listDocRenderables(docClear)[0].node;

    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:256px;height:256px';
    document.body.appendChild(holder);
    window.setUsdSceneTransparency(true);
    const handle = await window.createMtlxSceneView({ container: holder, stage, version: '1.39.5' });
    handle.setBackdrop('none');
    handle.setEnvironment(window.makeFlatEnvironment([0.1, 0.1, 0.1]));
    handle.setSkyVisibility(false);
    handle.setAmbientOcclusionEnabled(false);
    handle.setShadowsEnabled(false);
    handle.camera.position.set(0, 0, 5);
    handle.camera.fov = 45;
    handle.camera.aspect = 1;
    // Perspective depth precision is governed by the far/near ratio, not by
    // world distance; a near/far pair tight around the actual content keeps
    // this scene's 0.5-unit z range out of the curve's compressed part.
    handle.camera.near = 4.0;
    handle.camera.far = 5.3;
    handle.camera.lookAt(0, 0, 0);
    handle.camera.updateMatrixWorld(true);
    handle.camera.updateProjectionMatrix();

    const THREE = window.THREE;
    const gl = handle.renderer.getContext();
    while (gl.getError() !== gl.NO_ERROR) { /* clear stale diagnostics before the measured render */ }
    handle.renderNow();

    const size = handle.renderer.getDrawingBufferSize(new THREE.Vector2());
    // NDC z maps to normalized depth the same way the WebGL depth buffer
    // does (0.5*z+0.5); y flips because __opaqueDepthAt takes a top-left pixel.
    const project = (x, y, z) => {
      const ndc = new THREE.Vector3(x, y, z).project(handle.camera);
      return {
        px: Math.round((ndc.x * 0.5 + 0.5) * size.x),
        py: Math.round((1 - (ndc.y * 0.5 + 0.5)) * size.y),
        depth: ndc.z * 0.5 + 0.5,
      };
    };
    const bare = project(-0.3, 0, 0);
    const behindClear = project(0.3, 0, 0);
    const behindOpaque = project(-0.9, 0, 0.5);
    const clearOverBg = project(1.3, 0, 0.3);

    const bareProbe = handle.__opaqueDepthAt(bare.px, bare.py);
    const behindClearProbe = handle.__opaqueDepthAt(behindClear.px, behindClear.py);
    const behindOpaqueProbe = handle.__opaqueDepthAt(behindOpaque.px, behindOpaque.py);
    const clearOverBgProbe = handle.__opaqueDepthAt(clearOverBg.px, clearOverBg.py);
    const glErrorAfterProbes = gl.getError();

    const debug = handle.__debug();
    const clearMaterial = handle.prims[2].material;

    handle.setShadowsEnabled(true);
    handle.renderNow();
    const shadowDebug = handle.__shadowDebug();

    handle.dispose();
    holder.remove();
    docOpaque.delete();
    docClear.delete();

    return {
      bare, behindClear, behindOpaque, clearOverBg,
      bareProbe, behindClearProbe, behindOpaqueProbe, clearOverBgProbe,
      glErrorAfterProbes,
      sceneRgbtMode: debug.sceneRgbt && debug.sceneRgbt.mode,
      thicknessInfo: debug.thickness,
      clearPeel: !!clearMaterial.userData.mtlxScenePeel,
      clearPrepassMode: clearMaterial.userData.mtlxScenePrepassCoverage && clearMaterial.userData.mtlxScenePrepassCoverage.mode,
      prepassClear: shadowDebug.prepass ? shadowDebug.prepass.clear : null,
    };
  }, { opaqueXml: OPAQUE_XML, clearXml: CLEAR_XML, stage: STAGE });

  console.log('[opaque-depth]', JSON.stringify(result));

  expect(result.sceneRgbtMode).toBe('rgbt');
  expect(result.glErrorAfterProbes).toBe(0);

  expect(result.bareProbe.supported).toBe(true);
  expect(result.behindClearProbe.supported).toBe(true);
  expect(result.behindOpaqueProbe.supported).toBe(true);
  expect(result.clearOverBgProbe.supported).toBe(true);

  // Behind the clear box: the opaque depth is the receiver's own depth,
  // verified both against the camera projection and a bare-receiver pixel.
  expect(Math.abs(result.behindClearProbe.depth - result.behindClear.depth)).toBeLessThan(2e-3);
  expect(Math.abs(result.behindClearProbe.depth - result.bareProbe.depth)).toBeLessThan(1e-4);

  // Behind the opaque box: the opaque depth is the box's own front face,
  // nearer the camera than the receiver it stands in front of.
  expect(Math.abs(result.behindOpaqueProbe.depth - result.behindOpaque.depth)).toBeLessThan(2e-3);
  expect(result.behindOpaqueProbe.depth).toBeLessThan(result.bareProbe.depth - 0.01);

  // A clear box over empty background still writes nothing: the pixel reads
  // back the depth-clear far value.
  expect(result.clearOverBgProbe.depth).toBeGreaterThan(0.999);

  expect(result.clearPeel).toBe(true);
  expect(result.clearPrepassMode).toBe('clear');
  expect(result.thicknessInfo.allocatedVolumes).toBe(0);
  expect(result.prepassClear).toBeGreaterThanOrEqual(1);
});
