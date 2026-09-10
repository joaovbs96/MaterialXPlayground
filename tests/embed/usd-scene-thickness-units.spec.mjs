import { test, expect } from './lib/test-base.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const openPbrPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'materials', 'open_pbr_default.mtlx');
const OPEN_PBR_XML = fs.readFileSync(openPbrPath, 'utf8');

async function inspectUnits(page, embedURL, { metersPerUnit, length, depth, weight = 1 }) {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  return page.evaluate(async ({ xml, stage }) => {
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const node = window.listDocRenderables(doc)[0]?.node;
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:96px;height:96px';
    document.body.appendChild(holder);
    const handle = await window.createMtlxSceneView({ container: holder, stage: { ...stage, materials: [{ path: '/Material', node }] }, version: '1.39.5' });
    handle.setSkyVisibility(false);
    handle.setShadowsEnabled(false);
    handle.setAmbientOcclusionEnabled(false);
    handle.camera.position.set(0, 0, 1);
    handle.camera.lookAt(0, 0, 0);
    handle.camera.updateMatrixWorld(true);
    handle.renderNow();
    const material = handle.prims[0].material;
    const debug = handle.__debug();
    const thicknessSample = new Float32Array(4);
    if (debug.thicknessTarget) debug.renderer.readRenderTargetPixels(debug.thicknessTarget, 48, 48, 1, 1, thicknessSample);
    const worldLength = stage.length * stage.metersPerUnit;
    const frontDistance = new window.THREE.Vector3(0, 0, worldLength * 0.5).distanceTo(handle.camera.position);
    const fragmentShader = material.fragmentShader || '';
    const result = {
      scale: Number(debug.thicknessScale), depth: Number(stage.depth), worldLength,
      thicknessSample: Number(thicknessSample[0]), pathLength: Number(thicknessSample[0] - frontDistance),
      transparent: !!material.userData?.mtlxSceneTransparent,
      peel: !!material.userData?.mtlxScenePeel,
      volume: !!material.userData?.mtlxSceneVolume,
      prepassMode: material.userData?.mtlxScenePrepassCoverage?.mode || null,
      prepassOpacity: Number(material.userData?.mtlxScenePrepassCoverage?.opacity),
      hasTarget: !!debug.thicknessTarget,
      uniformScale: Number(material.uniforms?.u_thicknessScale?.value),
      hasThicknessPath: /mx_transmission_path_length/.test(fragmentShader) && /u_thicknessScale/.test(fragmentShader),
      hasThicknessInput: /transmission_depth/.test(fragmentShader), compiled: !!material.userData?.mtlxSceneCompiled?.vs,
    };
    handle.dispose();
    holder.remove();
    doc.delete();
    return result;
  }, {
    xml: OPEN_PBR_XML
      .replace(/(<input name="transmission_weight" type="float" value=")[^"]+(")/, `$1${weight}$2`)
      .replace(/(<input name="transmission_color" type="color3" value=")[^"]+(")/, '$10.8,0.9,1$2')
      .replace(/(<input name="transmission_depth" type="float" value=")[^"]+(")/, `$1${depth}$2`),
    stage: {
      upAxis: 'Y', metersPerUnit, length, depth, materials: [], lights: [],
      meshes: [{
        primPath: '/TransmissiveSlab', materialPath: '/Material',
        positions: new Float32Array([
          -length * 0.5, -length * 0.5, -length * 0.5, length * 0.5, -length * 0.5, -length * 0.5, length * 0.5, length * 0.5, -length * 0.5, -length * 0.5, length * 0.5, -length * 0.5,
          -length * 0.5, -length * 0.5, length * 0.5, length * 0.5, -length * 0.5, length * 0.5, length * 0.5, length * 0.5, length * 0.5, -length * 0.5, length * 0.5, length * 0.5,
        ]),
        normals: null, uvs: null,
        indices: new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]),
      }],
    },
  });
}

test('@scene OpenPBR transmission depth keeps the same physical ratio across metersPerUnit', async ({ page, embedURL }) => {
  const centimetreStage = await inspectUnits(page, embedURL, { metersPerUnit: 0.01, length: 10, depth: 10 });
  const metreStage = await inspectUnits(page, embedURL, { metersPerUnit: 1, length: 0.1, depth: 0.1 });
  console.log('[thickness-units]', JSON.stringify({ centimetreStage, metreStage }));
  expect(centimetreStage.compiled).toBe(true);
  expect(metreStage.compiled).toBe(true);
  expect(centimetreStage.hasThicknessPath).toBe(true);
  expect(metreStage.hasThicknessPath).toBe(true);
  expect(centimetreStage.hasThicknessInput).toBe(true);
  expect(metreStage.hasThicknessInput).toBe(true);
  expect(centimetreStage.worldLength).toBeCloseTo(0.1, 6);
  expect(metreStage.worldLength).toBeCloseTo(0.1, 6);
  expect(centimetreStage.scale).toBeCloseTo(100, 6);
  expect(metreStage.scale).toBeCloseTo(1, 6);
  expect(centimetreStage.uniformScale).toBeCloseTo(centimetreStage.scale, 6);
  expect(metreStage.uniformScale).toBeCloseTo(metreStage.scale, 6);
  expect(centimetreStage.thicknessSample).toBeGreaterThan(centimetreStage.worldLength * 5);
  expect(metreStage.thicknessSample).toBeGreaterThan(metreStage.worldLength * 5);
  expect((centimetreStage.pathLength * centimetreStage.scale) / centimetreStage.depth).toBeCloseTo(1, 3);
  expect((metreStage.pathLength * metreStage.scale) / metreStage.depth).toBeCloseTo(1, 3);
  expect(centimetreStage.scale / centimetreStage.depth).toBeCloseTo(metreStage.scale / metreStage.depth, 6);
});

test('@scene source-qualified prepass excludes opaque OpenPBR uniforms and keeps static transmission', async ({ page, embedURL }) => {
  const opaque = await inspectUnits(page, embedURL, { metersPerUnit: 1, length: 0.1, depth: 0.1, weight: 0 });
  const partial = await inspectUnits(page, embedURL, { metersPerUnit: 1, length: 0.1, depth: 0.1, weight: 0.05 });
  expect(opaque.compiled).toBe(true);
  expect(opaque.peel).toBe(false);
  expect(opaque.volume).toBe(false);
  expect(opaque.prepassMode).toBe('static');
  expect(opaque.hasTarget).toBe(false);
  expect(opaque.prepassOpacity).toBeCloseTo(1, 5);
  expect(partial.compiled).toBe(true);
  expect(partial.peel).toBe(true);
  expect(partial.volume).toBe(true);
  expect(partial.prepassMode).toBe('static');
  expect(partial.prepassOpacity).toBeCloseTo(0.955, 3);
  expect(partial.hasTarget).toBe(true);
});
