import { test, expect } from './lib/test-base.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function cubeFixture() {
  const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-subdivision');
  const bytes = fs.readFileSync(path.join(fixtureRoot, 'cube.usda'));
  return [{
    path: 'cube.usda',
    data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }];
}

async function loadCubes(page, subdivisionLevel) {
  const files = cubeFixture().map(file => ({ path: file.path, data: Array.from(new Uint8Array(file.data)) }));
  return page.evaluate(async ({ serializedFiles, subdivisionLevel }) => {
    const files = serializedFiles.map(file => ({ path: file.path, data: Uint8Array.from(file.data).buffer }));
    const { loadUsdStage } = await import(`${location.origin}/js/usd/index.js`);
    const stage = await loadUsdStage({ files, rootPath: 'cube.usda', subdivisionLevel });
    return {
      warnings: stage.warnings ?? [],
      meshes: stage.meshes.map(mesh => ({
        primPath: mesh.primPath,
        positions: Array.from(mesh.positions ?? []),
        normals: Array.from(mesh.normals ?? []),
        uvs: Array.from(mesh.uvs ?? []),
        indexCount: mesh.indices?.length ?? null,
      })),
    };
  }, { serializedFiles: files, subdivisionLevel });
}

function maxDistanceFromCenter(positions, center) {
  let max = 0;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const dx = positions[i] - center[0], dy = positions[i + 1] - center[1], dz = positions[i + 2] - center[2];
    max = Math.max(max, Math.hypot(dx, dy, dz));
  }
  return max;
}

function normalLengths(normals) {
  const lengths = [];
  for (let i = 0; i + 2 < normals.length; i += 3) {
    lengths.push(Math.hypot(normals[i], normals[i + 1], normals[i + 2]));
  }
  return lengths;
}

test('@scene Loop subdivision rounds catmullClark cages and leaves none meshes untouched', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html');

  const level0 = await loadCubes(page, 0);
  const level1 = await loadCubes(page, 1);

  const cc0 = level0.meshes.find(m => /CatmullClarkCube/.test(m.primPath));
  const none0 = level0.meshes.find(m => /UnsubdividedCube/.test(m.primPath));
  const cc1 = level1.meshes.find(m => /CatmullClarkCube/.test(m.primPath));
  const none1 = level1.meshes.find(m => /UnsubdividedCube/.test(m.primPath));

  expect(cc0).toBeTruthy();
  expect(none0).toBeTruthy();
  expect(cc1).toBeTruthy();
  expect(none1).toBeTruthy();

  const triCount0 = cc0.positions.length / 9;
  const triCount1 = cc1.positions.length / 9;
  expect(triCount1).toBeCloseTo(triCount0 * 4, 5);

  // Level 0 leaves both meshes untouched.
  expect(cc0.positions.length / 9).toBe(12); // 6 quads * 2 tris
  expect(none0.positions.length / 9).toBe(12);
  expect(none1.positions.length).toBe(none0.positions.length);
  for (let i = 0; i < none0.positions.length; i++) {
    expect(none1.positions[i]).toBeCloseTo(none0.positions[i], 5);
  }

  // Corner vertices of the subdivided cube move inward (max distance from
  // center shrinks relative to the unsubdivided cage).
  const center = [-2, 0, 0];
  const maxD0 = maxDistanceFromCenter(cc0.positions, center);
  const maxD1 = maxDistanceFromCenter(cc1.positions, center);
  expect(maxD1).toBeLessThan(maxD0);

  // Every normal is unit length, all streams finite, UVs stay in [0,1].
  for (const mesh of [cc0, cc1, none0, none1]) {
    for (const value of mesh.positions) expect(Number.isFinite(value)).toBe(true);
    for (const len of normalLengths(mesh.normals)) expect(len).toBeCloseTo(1, 3);
    for (const uv of mesh.uvs) {
      expect(Number.isFinite(uv)).toBe(true);
      expect(uv).toBeGreaterThanOrEqual(-1e-4);
      expect(uv).toBeLessThanOrEqual(1 + 1e-4);
    }
  }
});
