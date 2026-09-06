import { test, expect } from './lib/test-base.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Signed volume via the divergence theorem over a closed, outward-wound,
// nonindexed triangle stream: positions are taken relative to the mesh
// centroid so a translated twin cube scores the same as one at the origin.
function signedVolume(positions) {
  let volume = 0;
  const count = positions.length / 3;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < count; i++) {
    cx += positions[i * 3]; cy += positions[i * 3 + 1]; cz += positions[i * 3 + 2];
  }
  cx /= count; cy /= count; cz /= count;
  for (let i = 0; i + 2 < count; i += 3) {
    const ax = positions[i * 3] - cx, ay = positions[i * 3 + 1] - cy, az = positions[i * 3 + 2] - cz;
    const bx = positions[(i + 1) * 3] - cx, by = positions[(i + 1) * 3 + 1] - cy, bz = positions[(i + 1) * 3 + 2] - cz;
    const dx = positions[(i + 2) * 3] - cx, dy = positions[(i + 2) * 3 + 1] - cy, dz = positions[(i + 2) * 3 + 2] - cz;
    const crossX = by * dz - bz * dy;
    const crossY = bz * dx - bx * dz;
    const crossZ = bx * dy - by * dx;
    volume += (ax * crossX + ay * crossY + az * crossZ) / 6;
  }
  return { volume, centroid: [cx, cy, cz] };
}

function everyNormalOutward(positions, normals, centroid) {
  const [cx, cy, cz] = centroid;
  const count = positions.length / 3;
  for (let i = 0; i < count; i++) {
    const dx = positions[i * 3] - cx, dy = positions[i * 3 + 1] - cy, dz = positions[i * 3 + 2] - cz;
    const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
    if (dx * nx + dy * ny + dz * nz <= 0) return false;
  }
  return true;
}

function readFixture(...relativeParts) {
  const bytes = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', ...relativeParts));
  return Array.from(bytes);
}

test('@scene honors leftHanded orientation for ordinary meshes: outward normals, positive volume', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html');
  const data = readFixture('usd-normals', 'left-handed.usda');
  const result = await page.evaluate(async ({ data }) => {
    const { loadUsdStage } = await import(`${location.origin}/js/usd/index.js`);
    const stage = await loadUsdStage({
      files: [{ path: 'left-handed.usda', data: Uint8Array.from(data).buffer }],
      rootPath: 'left-handed.usda',
    });
    return {
      meshes: stage.meshes.map(mesh => ({
        primPath: mesh.primPath,
        orientation: mesh.orientation,
        positions: Array.from(mesh.positions ?? []),
        normals: Array.from(mesh.normals ?? []),
      })),
      warnings: stage.warnings,
    };
  }, { data });

  expect(result.warnings).toEqual([]);
  expect(result.meshes).toHaveLength(2);
  const leftHanded = result.meshes.find(mesh => mesh.primPath.endsWith('LeftHandedCube'));
  const rightHanded = result.meshes.find(mesh => mesh.primPath.endsWith('RightHandedCube'));
  expect(leftHanded).toBeTruthy();
  expect(rightHanded).toBeTruthy();
  expect(leftHanded.orientation).toBe('leftHanded');
  expect(rightHanded.orientation).toBe('rightHanded');

  for (const mesh of [leftHanded, rightHanded]) {
    expect(mesh.positions.length).toBeGreaterThan(0);
    expect(mesh.normals.length).toBe(mesh.positions.length);
    const { volume, centroid } = signedVolume(mesh.positions);
    expect(volume).toBeGreaterThan(0);
    expect(everyNormalOutward(mesh.positions, mesh.normals, centroid)).toBe(true);
  }
});

test('@scene recovers outward normals for a leftHanded PointInstancer prototype', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html');
  const files = [
    { path: 'left-handed-mesh-reference-root.usda', data: readFixture('usd-scene', 'left-handed-mesh-reference-root.usda') },
    { path: 'nested/left-handed-mesh-instanced.usda', data: readFixture('usd-scene', 'nested', 'left-handed-mesh-instanced.usda') },
  ];
  const result = await page.evaluate(async serializedFiles => {
    const { loadUsdStage } = await import(`${location.origin}/js/usd/index.js`);
    const stage = await loadUsdStage({
      files: serializedFiles.map(file => ({ path: file.path, data: Uint8Array.from(file.data).buffer })),
      rootPath: 'left-handed-mesh-reference-root.usda',
    });
    return {
      warnings: stage.warnings,
      meshes: stage.meshes.map(mesh => ({
        path: mesh.primPath,
        orientation: mesh.orientation,
        owner: mesh.instanceOwnerPath ?? null,
        positions: Array.from(mesh.positions ?? []),
        normals: Array.from(mesh.normals ?? []),
      })),
    };
  }, files);

  expect(result.warnings.filter(warning => /PointInstancer/i.test(warning))).toEqual([]);
  const instanced = result.meshes.find(mesh => mesh.owner);
  const ordinary = result.meshes.find(mesh => !mesh.owner);
  expect(instanced).toBeTruthy();
  expect(ordinary).toBeTruthy();
  expect(instanced.orientation).toBe('leftHanded');
  expect(ordinary.orientation).toBe('leftHanded');
  expect(instanced.normals.length).toBe(instanced.positions.length);
  const { centroid } = signedVolume(instanced.positions);
  expect(everyNormalOutward(instanced.positions, instanced.normals, centroid)).toBe(true);
  const ordinaryVolume = signedVolume(ordinary.positions);
  expect(ordinaryVolume.volume).toBeGreaterThan(0);
  expect(everyNormalOutward(ordinary.positions, ordinary.normals, ordinaryVolume.centroid)).toBe(true);
});
