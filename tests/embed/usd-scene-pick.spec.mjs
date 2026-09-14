// tests/embed/usd-scene-pick.spec.mjs: handle.pickAt (js/usd-scene-renderer.js)
// raycasts from a client point through the active camera onto the visible,
// non-excluded prims and reports the hit prim/material. Uses the existing
// camera-root.usda + nested.usda fixtures: CamFront looks down -Z at the
// composed QuadWithSubset mesh, whose two faces are bound to different
// MaterialX materials (red/blue), giving a real multi-material mesh.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-scene');
function fixtureFile(relativePath) {
  return { name: relativePath, mimeType: 'text/plain', buffer: fs.readFileSync(path.join(fixtureRoot, relativePath)) };
}

test('@scene pickAt raycasts a client point onto the hit prim and its face material', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    fixtureFile('camera-root.usda'),
    fixtureFile('nested/nested.usda'),
    fixtureFile('nested/materials/red.mtlx'),
    fixtureFile('nested/materials/blue.mtlx'),
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-scene-error')).toHaveCount(0);

  const cameraSelect = page.getByTestId('usd-scene-camera-select');
  await cameraSelect.getByRole('combobox').click();
  await page.getByRole('option', { name: /CamFront/ }).click();
  await page.waitForTimeout(150);

  const result = await page.evaluate(() => {
    const handle = window.__mtlxUsdSceneHandle;
    const mesh = handle.prims.find((o) => /QuadWithSubset\/Quad$/.test(o.userData.primPath || ''));
    if (!mesh) throw new Error('QuadWithSubset/Quad prim not found');
    const pos = mesh.geometry.attributes.position;
    const localCentroid = (predicate) => {
      const box = new THREE.Box3();
      for (let i = 0; i < pos.count; i++) {
        const p = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
        if (predicate(p)) box.expandByPoint(p);
      }
      return box.getCenter(new THREE.Vector3());
    };
    mesh.updateMatrixWorld(true);
    const redWorld = localCentroid((p) => p.x <= 0.001).applyMatrix4(mesh.matrixWorld);
    const blueWorld = localCentroid((p) => p.x >= -0.001).applyMatrix4(mesh.matrixWorld);

    const canvas = handle.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const toClient = (world) => {
      const ndc = world.clone().project(handle.camera);
      return {
        x: rect.left + (ndc.x * 0.5 + 0.5) * rect.width,
        y: rect.top + (1 - (ndc.y * 0.5 + 0.5)) * rect.height,
      };
    };
    const redClient = toClient(redWorld);
    const blueClient = toClient(blueWorld);
    const bgClient = { x: rect.left + 4, y: rect.top + 4 };

    return {
      redPrimPath: mesh.userData.primPath,
      redHit: handle.pickAt(redClient.x, redClient.y),
      blueHit: handle.pickAt(blueClient.x, blueClient.y),
      backgroundHit: handle.pickAt(bgClient.x, bgClient.y),
    };
  });

  expect(result.redHit).toBeTruthy();
  expect(result.redHit.primPath).toBe(result.redPrimPath);
  expect(result.redHit.materialName).toBe('RedMaterial');
  expect(result.redHit.materialPath).toContain('RedMaterial');
  expect(Array.isArray(result.redHit.point)).toBe(true);
  expect(typeof result.redHit.distance).toBe('number');

  expect(result.blueHit).toBeTruthy();
  expect(result.blueHit.primPath).toBe(result.redPrimPath);
  expect(result.blueHit.materialName).toBe('BlueMaterial');
  expect(result.blueHit.materialPath).toContain('BlueMaterial');

  expect(result.backgroundHit).toBeNull();
});
