import { test, expect } from './lib/test-base.mjs';
import fs from 'node:fs';
import path from 'node:path';

test('@scene preserves authored face-varying hard-edge normals in extraction', async ({ page, embedURL }) => {
  const fixture = path.resolve('tests/fixtures/usd-normals/face-varying.usda');
  const bytes = fs.readFileSync(fixture);
  await page.goto(embedURL + '/index.html');
  const result = await page.evaluate(async ({ data }) => {
    const { loadUsdStage } = await import(`${location.origin}/js/usd/index.js`);
    const stage = await loadUsdStage({
      files: [{ path: 'face-varying.usda', data: Uint8Array.from(data).buffer }],
      rootPath: 'face-varying.usda',
    });
    const mesh = stage.meshes[0];
    return {
      positions: Array.from(mesh.positions || []),
      normals: Array.from(mesh.normals || []),
      indices: Array.from(mesh.indices || []),
    };
  }, { data: Array.from(bytes) });
  expect(result.positions.length).toBe(result.normals.length);
  expect(result.positions.length).toBe(18);
  // The fixture explicitly sets subdivisionScheme=none. Current native draw
  // extraction still smooths shared face-varying corners after successful
  // extraction, so retain only the normative-value assertion as an expected
  // failure until authored interpolation or indices are exposed.
  test.fail(true, 'Native extraction smooths authored face-varying normals');
  expect(result.normals.slice(0, 9)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  expect(result.normals.slice(9, 18)).toEqual([0, 1, 0, 0, 1, 0, 0, 1, 0]);
  expect(result.indices.length === 0 || result.indices.length === 6).toBe(true);
});
