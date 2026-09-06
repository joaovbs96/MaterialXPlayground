import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const chessRoot = process.env.USD_CHESS_ROOT || '';

function chessDirectory() {
  if (!chessRoot || !fs.existsSync(chessRoot)) return '';
  return fs.statSync(chessRoot).isDirectory() ? chessRoot : path.dirname(chessRoot);
}

function writeSnapshot(dataUrl, name) {
  const dir = path.resolve('docs/local/material-diagnostics');
  fs.mkdirSync(dir, { recursive: true });
  const output = path.join(dir, name);
  fs.writeFileSync(output, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
  return output;
}

function changedPixels(leftUrl, rightUrl) {
  const left = decodePNG(Buffer.from(String(leftUrl).split(',')[1], 'base64'));
  const right = decodePNG(Buffer.from(String(rightUrl).split(',')[1], 'base64'));
  if (left.width !== right.width || left.height !== right.height) return { changed: -1, total: 0 };
  let changed = 0;
  for (let y = 0; y < left.height; y++) for (let x = 0; x < left.width; x++) {
    const a = left.getPixel(x, y); const b = right.getPixel(x, y);
    if (Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b)) > 2) changed++;
  }
  return { changed, total: left.width * left.height };
}

test('@scene restores smooth Pawn instance normals from the composed prototype', async ({ page, embedURL }) => {
  const directory = chessDirectory();
  test.skip(!directory, 'Set USD_CHESS_ROOT to the supplied OpenChessSet directory to run the full Chess acceptance gate.');
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => typeof window.createMtlxSceneView === 'function', null, { timeout: 30000 });
  const input = page.locator('input[type=file][webkitdirectory]').first();
  await input.setInputFiles(directory);

  const result = await page.evaluate(async () => {
    const inputElement = document.querySelector('input[type=file][webkitdirectory]');
    const files = Array.from(inputElement?.files || []).map(file => ({
      path: file.webkitRelativePath || file.name,
      data: file,
    }));
    const rootFile = files.find(file => /(?:^|\/)chess_set\.usda$/i.test(file.path));
    if (!rootFile) throw new Error('Chess folder upload did not contain chess_set.usda');
    const { loadUsdStage } = await import(`${location.origin}/js/usd/index.js`);
    const stage = await loadUsdStage({ files, rootPath: rootFile.path });
    const instanceRecords = stage.meshes.filter(mesh => mesh.instanceMatrices?.length);
    const afterStage = {
      ...stage,
      meshes: stage.meshes.map(mesh => ({
        ...mesh,
        positions: mesh.positions && new Float32Array(mesh.positions),
        normals: mesh.normals && new Float32Array(mesh.normals),
        uvs: mesh.uvs && new Float32Array(mesh.uvs),
        indices: mesh.indices && new Uint32Array(mesh.indices),
      })),
    };
    const beforeStage = {
      ...afterStage,
      meshes: afterStage.meshes.map(mesh => mesh.instanceMatrices?.length
        ? { ...mesh, normals: undefined }
        : mesh),
    };
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:700px;background:#111;z-index:9999;';
    document.body.appendChild(holder);
    const viewInfo = view => ({
      prims: view.prims.length,
      pawnPrims: view.prims.filter(object => /\/__instances__\/Pawn\//.test(String(object.userData.geometryPath || ''))).length,
      ordinaryPrims: view.prims.filter(object => !/\/__instances__\/Pawn\//.test(String(object.userData.geometryPath || ''))).length,
      compiledRawPrims: view.prims.filter(object => object.material?.isRawShaderMaterial && object.material.userData?.mtlxSceneCompiled).length,
      warnings: view.warnings.slice(),
    });
    const focusPawns = view => {
      // Keep the A/B comparison legible by framing one front black pawn's
      // top and body. The full-scene snapshot below still covers every object.
      const pawns = view.prims.filter(object => /\/__instances__\/Pawn\//.test(String(object.userData.geometryPath || ''))
        && object.userData.instanceIndex === 0
        && String(object.userData.primPath || '').includes('/Black/Pawns'));
      if (!pawns.length) throw new Error('Could not select a black Pawn instance for the close-up');
      view.prims.forEach(object => { object.visible = pawns.includes(object); });
      const box = new THREE.Box3();
      pawns.forEach(object => box.expandByObject(object));
      const center = box.getCenter(new THREE.Vector3());
      const radius = box.getSize(new THREE.Vector3()).length() * 0.5 || 1;
      view.camera.position.copy(center).add(new THREE.Vector3(0.8, 0.35, 1.1).normalize().multiplyScalar(radius * 2.4));
      view.camera.near = Math.max(radius / 1000, 0.001);
      view.camera.far = Math.max(radius * 8, 100);
      view.camera.lookAt(center);
      view.camera.updateProjectionMatrix();
      view.renderNow();
    };
    const showAll = view => view.prims.forEach(object => { object.visible = true; });
    const before = await window.createMtlxSceneView({ container: holder, stage: beforeStage, files, isMounted: () => true });
    focusPawns(before);
    const beforeDataUrl = before.snapshot();
    const beforeInfo = viewInfo(before);
    before.dispose();
    const after = await window.createMtlxSceneView({ container: holder, stage: afterStage, files, isMounted: () => true });
    focusPawns(after);
    const afterPawnDataUrl = after.snapshot();
    const afterInfo = viewInfo(after);
    showAll(after);
    after.frameAll();
    const fullDataUrl = after.snapshot();
    after.dispose();
    holder.remove();
    return {
      stageMeshes: stage.meshes.length,
      stageMaterials: stage.materials.length,
      instanceRecords: instanceRecords.map(mesh => ({
        path: mesh.primPath,
        instances: mesh.instanceMatrices.length,
        normals: mesh.normals?.length ?? 0,
        positions: mesh.positions?.length ?? 0,
      })),
      stageWarnings: stage.warnings,
      beforeInfo,
      afterInfo,
      beforeDataUrl,
      afterPawnDataUrl,
      fullDataUrl,
    };
  });

  const beforePath = writeSnapshot(result.beforeDataUrl, 'chess-pawn-normals-before.png');
  const afterPath = writeSnapshot(result.afterPawnDataUrl, 'chess-pawn-normals-after.png');
  const fullPath = writeSnapshot(result.fullDataUrl, 'chess-full-after.png');
  const delta = changedPixels(result.beforeDataUrl, result.afterPawnDataUrl);
  console.log(JSON.stringify({ ...result, beforeDataUrl: undefined, afterPawnDataUrl: undefined, fullDataUrl: undefined, screenshots: { beforePath, afterPath, fullPath }, delta }));

  expect(result.stageWarnings).toEqual([]);
  expect(result.instanceRecords).toHaveLength(4);
  expect(result.instanceRecords.every(record => record.instances === 8 && record.normals === record.positions)).toBe(true);
  expect(result.afterInfo.prims).toBe(49);
  expect(result.afterInfo.pawnPrims).toBe(32);
  expect(result.afterInfo.ordinaryPrims).toBe(17);
  expect(result.afterInfo.compiledRawPrims).toBe(49);
  expect(result.afterInfo.warnings).toEqual([]);
  expect(delta.changed).toBeGreaterThan(100);
});
