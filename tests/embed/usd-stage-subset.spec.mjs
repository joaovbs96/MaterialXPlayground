import { test, expect } from './lib/test-base.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function subsetInstancerFixture() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-pointinstancer-subset');
  return ['root.usda', 'direct.usda', 'nested/instanced.usda', 'nested/prototype.usda', 'nested/materials/red.mtlx', 'nested/materials/blue.mtlx']
    .map(filePath => {
      const bytes = fs.readFileSync(path.join(root, filePath));
      return {
        path: filePath,
        data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    });
}

test('@scene preserves GeomSubset groups inside a PointInstancer prototype', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html');
  const serialized = subsetInstancerFixture().map(file => ({
    path: file.path,
    data: Array.from(new Uint8Array(file.data)),
  }));
  const result = await page.evaluate(async files => {
    const { loadUsdStage } = await import(`${location.origin}/js/usd/index.js`);
    const load = rootPath => loadUsdStage({
      files: files.map(file => ({ path: file.path, data: Uint8Array.from(file.data).buffer })),
      rootPath,
    });
    const direct = await load('direct.usda');
    const instanced = await load('root.usda');
    const describe = stage => ({
      meshes: stage.meshes.map(mesh => ({
        path: mesh.primPath,
        owner: mesh.instanceOwnerPath ?? null,
        instances: (mesh.instanceMatrices ?? []).map(matrix => Array.from(matrix)),
        indexCount: mesh.indices?.length ?? 0,
        vertexCount: mesh.positions?.length ?? 0,
        materialPath: mesh.materialPath ?? null,
        groups: (mesh.groups ?? []).map(group => ({
          start: group.start,
          count: group.count,
          materialPath: group.materialPath ?? mesh.materialPath ?? null,
        })),
      })),
      warnings: stage.warnings,
    });
    return {
      direct: describe(direct),
      instanced: describe(instanced),
    };
  }, serialized);

  expect(result.direct.warnings.filter(warning => /PointInstancer|subset/i.test(warning))).toEqual([]);
  const directMesh = result.direct.meshes.find(mesh => /\/Direct\/Quad$/.test(mesh.path));
  expect(directMesh).toBeDefined();
  expect(directMesh.owner).toBeNull();
  const directCount = directMesh.indexCount || directMesh.vertexCount / 3;
  expect(directCount).toBe(12);
  expect(directMesh.groups).toHaveLength(2);
  expect(directMesh.groups.map(group => group.materialPath).sort()).toEqual([
    expect.stringMatching(/\/BlueMaterial$/),
    expect.stringMatching(/\/RedMaterial$/),
  ]);
  expect(directMesh.groups.reduce((total, group) => total + group.count, 0)).toBe(directCount);

  const extractionWarnings = result.instanced.warnings.filter(warning =>
    !/PointInstancer normal recovery stream mismatch/i.test(warning));
  expect(extractionWarnings.filter(warning => /PointInstancer|subset/i.test(warning))).toEqual([]);
  const instanceMeshes = result.instanced.meshes.filter(mesh => mesh.owner && mesh.instances.length);
  expect(instanceMeshes).toHaveLength(1);
  const mesh = instanceMeshes[0];
  expect(mesh.path).toMatch(/\/Instances\/__instances__\/Prototype\/Quad$/);
  expect(mesh.instances).toHaveLength(2);
  expect(mesh.instances.every(matrix => matrix.length === 16 && matrix.every(Number.isFinite))).toBe(true);
  const effectiveCount = mesh.indexCount || mesh.vertexCount / 3;
  expect(effectiveCount).toBe(12);
  // The pinned native extractor drops the explicit BlueFace group while
  // retaining the parent red group. Keep only this desired contract asserted
  // as an expected failure until native subset extraction is fixed.
  test.fail();
  expect(mesh.groups).toHaveLength(2);
  expect(mesh.groups.map(group => group.materialPath).sort()).toEqual([
    expect.stringMatching(/\/BlueMaterial$/),
    expect.stringMatching(/\/RedMaterial$/),
  ]);
  expect(mesh.groups.map(group => [group.start, group.count]).sort((a, b) => a[0] - b[0])).toEqual([
    [0, 6],
    [6, 6],
  ]);
  expect(mesh.groups.reduce((total, group) => total + group.count, 0)).toBe(effectiveCount);
});
