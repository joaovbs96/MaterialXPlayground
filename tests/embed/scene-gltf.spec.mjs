// tests/embed/scene-gltf.spec.mjs: covers T3's glTF intake into the Scene
// Viewer (js/usd-scene-app.jsx's load() routing a .glb root through
// window.MtlxSceneSources.loadGltfStage instead of the USD worker). Not
// tagged @scene/@smoke: it is unexecuted (no node_modules in the worktree
// this was authored in), unlike the USD-only @scene specs beside it, and
// should be run once before being folded into that tier.
//
// Fixture: tests/fixtures/scene-gltf/cube.glb, regenerated deterministically
// by tests/fixtures/scene-gltf/make-cube.mjs (one cube, one untextured
// pbrMetallicRoughness material, baseColorFactor red 0.8/0.1/0.1).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'scene-gltf');
const CUBE_GLB = fs.readFileSync(path.join(fixtureRoot, 'cube.glb'));

test('glTF root loads through MtlxSceneSources and renders its red material', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();

  // A single .glb is its own root; pickDefaultRootLayer auto-picks it
  // (no USD candidate present), so this should auto-load without a
  // separate Root layer pick.
  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    { name: 'cube.glb', mimeType: 'model/gltf-binary', buffer: CUBE_GLB },
  ]);

  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-scene-error')).toHaveCount(0);

  // The stage payload loadGltfStage() returned is the same neutral shape
  // the USD worker returns; one material, exposed on the live handle the
  // renderer effect stashed at window.__mtlxUsdSceneHandle.
  const materialCount = await page.evaluate(() => window.__mtlxUsdSceneHandle.__sceneStage.materials.length);
  expect(materialCount).toBe(1);

  const canvas = page.getByTestId('usd-scene-canvas').locator('canvas');
  const shot = await canvas.screenshot();
  const png = decodePNG(shot);
  const cx = Math.floor(png.width / 2);
  const cy = Math.floor(png.height / 2);
  const p = png.getPixel(cx, cy);

  // Reddish, not the neutral grey of the empty-stage backdrop or an
  // unresolved default-color fallback: red channel clearly dominant.
  expect(p.r).toBeGreaterThan(p.g);
  expect(p.r).toBeGreaterThan(p.b);
});
